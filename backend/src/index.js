const express = require("express");
const { pool } = require("./db");
const { migrate } = require("./migrate");

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function wrap(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function asRoleList(v) {
  if (v == null || v === "") return [];
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return [...new Set(arr.map((r) => String(r).trim()).filter(Boolean))];
}

function asRoleOrNull(v) {
  if (v == null || v === "" || v === "none") return null;
  return String(v);
}

async function grantRole(client, userId, role) {
  if (!role) return;
  await client.query(
    `
    UPDATE "user"
    SET roles = ARRAY(SELECT DISTINCT unnest(roles || ARRAY[$2::role]))
    WHERE id = $1
    `,
    [userId, role]
  );
}

async function maybeCompleteWorkflow(client, workflowInsId) {
  const pending = await client.query(
    `
    SELECT 1
    FROM workflow_task_ins wti
    JOIN workflow_task_def wtd ON wtd.id = wti.workflow_task_def_id
    JOIN task_ins ti ON ti.id = wti.task_ins_id
    WHERE wti.workflow_ins_id = $1
      AND wtd.required = true
      AND ti.status <> 'completed'
    LIMIT 1
    `,
    [workflowInsId]
  );
  if (pending.rowCount === 0) {
    const done = await client.query(
      `
      UPDATE workflow_ins
      SET status = 'completed', completed_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING user_id, grants_role
      `,
      [workflowInsId]
    );
    if (done.rowCount) {
      await grantRole(client, done.rows[0].user_id, done.rows[0].grants_role);
    }
  }
}

async function findOrCreateTaskIns(client, userId, taskDefId) {
  const existing = await client.query(
    "SELECT * FROM task_ins WHERE user_id = $1 AND task_def_id = $2",
    [userId, taskDefId]
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (row.status === "expired") {
      const reopened = await client.query(
        `
        UPDATE task_ins
        SET status = 'pending', completed_at = NULL, expires_at = NULL, started_at = now()
        WHERE id = $1
        RETURNING *
        `,
        [row.id]
      );
      return reopened.rows[0];
    }
    return row;
  }
  try {
    const inserted = await client.query(
      `
      INSERT INTO task_ins (task_def_id, user_id, status, started_at)
      VALUES ($1, $2, 'pending', now())
      RETURNING *
      `,
      [taskDefId, userId]
    );
    return inserted.rows[0];
  } catch (err) {
    if (err.code !== "23505") throw err;
    const again = await client.query(
      "SELECT * FROM task_ins WHERE user_id = $1 AND task_def_id = $2",
      [userId, taskDefId]
    );
    return again.rows[0];
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get(
  "/api/roles",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `
      SELECT e.enumlabel AS role
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'role'
      ORDER BY e.enumsortorder
      `
    );
    res.json(rows.map((r) => r.role));
  })
);

app.get(
  "/api/users",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      'SELECT id, email, name, roles::text[] AS roles FROM "user" ORDER BY id'
    );
    res.json(rows);
  })
);

app.post(
  "/api/users",
  wrap(async (req, res) => {
    const { email, name, roles } = req.body;
    if (!email || !name) throw httpError(400, "email and name required");
    const { rows } = await pool.query(
      'INSERT INTO "user" (email, name, roles) VALUES ($1, $2, $3::role[]) RETURNING id, email, name, roles::text[] AS roles',
      [email, name, asRoleList(roles)]
    );
    res.status(201).json(rows[0]);
  })
);

app.post(
  "/api/users/:id/roles",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      'UPDATE "user" SET roles = $2::role[] WHERE id = $1 RETURNING id, email, name, roles::text[] AS roles',
      [req.params.id, asRoleList(req.body.roles)]
    );
    if (!rows.length) throw httpError(404, "user not found");
    res.json(rows[0]);
  })
);

app.get(
  "/api/users/:id",
  wrap(async (req, res) => {
    const user = await pool.query(
      'SELECT id, email, name, roles::text[] AS roles FROM "user" WHERE id = $1',
      [req.params.id]
    );
    if (!user.rowCount) throw httpError(404, "user not found");

    const workflowIns = await pool.query(
      `
      SELECT
        wi.id, wi.status, wi.started_at, wi.completed_at, wi.workflow_def_id, wi.grants_role,
        wd.code, wd.version, wd.name AS workflow_name, wd.status AS workflow_def_status
      FROM workflow_ins wi
      JOIN workflow_def wd ON wd.id = wi.workflow_def_id
      WHERE wi.user_id = $1
      ORDER BY wi.id
      `,
      [req.params.id]
    );

    const slots = workflowIns.rows.length
      ? await pool.query(
          `
          SELECT
            wti.workflow_ins_id,
            wti.id AS workflow_task_ins_id,
            wtd.id AS workflow_task_def_id,
            wtd.position,
            wtd.required,
            ti.id AS task_ins_id,
            ti.status AS task_ins_status,
            ti.started_at,
            ti.completed_at,
            ti.expires_at,
            td.id AS task_def_id,
            td.name AS task_name
          FROM workflow_task_ins wti
          JOIN workflow_task_def wtd ON wtd.id = wti.workflow_task_def_id
          JOIN task_ins ti ON ti.id = wti.task_ins_id
          JOIN task_def td ON td.id = ti.task_def_id
          WHERE wti.workflow_ins_id = ANY($1::int[])
          ORDER BY wtd.position, wti.id
          `,
          [workflowIns.rows.map((r) => r.id)]
        )
      : { rows: [] };

    const slotsByWf = {};
    for (const s of slots.rows) {
      (slotsByWf[s.workflow_ins_id] ||= []).push(s);
    }

    const taskIns = await pool.query(
      `
      SELECT
        ti.id, ti.status, ti.started_at, ti.completed_at, ti.expires_at,
        td.id AS task_def_id, td.name AS task_name, td.expires_after::text AS expires_after,
        COALESCE(
          ARRAY_AGG(wti.workflow_ins_id ORDER BY wti.workflow_ins_id)
            FILTER (WHERE wti.workflow_ins_id IS NOT NULL),
          '{}'
        ) AS workflow_ins_ids
      FROM task_ins ti
      JOIN task_def td ON td.id = ti.task_def_id
      LEFT JOIN workflow_task_ins wti ON wti.task_ins_id = ti.id
      WHERE ti.user_id = $1
      GROUP BY ti.id, td.id
      ORDER BY ti.id
      `,
      [req.params.id]
    );

    res.json({
      user: user.rows[0],
      workflow_ins: workflowIns.rows.map((w) => ({
        ...w,
        tasks: slotsByWf[w.id] || [],
      })),
      task_ins: taskIns.rows,
    });
  })
);

app.get(
  "/api/task-defs",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `
      SELECT id, name, type, config, expires_after::text AS expires_after,
             requires_approval, approver_roles::text[] AS approver_roles
      FROM task_def
      ORDER BY id
      `
    );
    res.json(rows);
  })
);

app.get(
  "/api/task-defs/:id",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, name, type, config, expires_after::text AS expires_after, requires_approval, approver_roles::text[] AS approver_roles FROM task_def WHERE id = $1",
      [req.params.id]
    );
    if (!rows.length) throw httpError(404, "task_def not found");
    res.json(rows[0]);
  })
);

app.post(
  "/api/task-defs",
  wrap(async (req, res) => {
    const { name, type, expires_after_days, requires_approval, approver_roles } = req.body;
    if (!name) throw httpError(400, "name required");
    const expires =
      expires_after_days === "" || expires_after_days == null
        ? null
        : `${Number(expires_after_days)} days`;
    if (expires && Number.isNaN(Number(expires_after_days))) {
      throw httpError(400, "expires_after_days must be a number");
    }
    const { rows } = await pool.query(
      `
      INSERT INTO task_def (name, type, expires_after, requires_approval, approver_roles)
      VALUES ($1, $2, $3::interval, $4, $5::role[])
      RETURNING id, name, type, config, expires_after::text AS expires_after, requires_approval, approver_roles::text[] AS approver_roles
      `,
      [
        name,
        type || "attest",
        expires,
        requires_approval === true || requires_approval === "true",
        asRoleList(approver_roles),
      ]
    );
    res.status(201).json(rows[0]);
  })
);

app.post(
  "/api/task-defs/:id",
  wrap(async (req, res) => {
    const { name, type, expires_after_days, requires_approval, approver_roles } = req.body;
    const current = await pool.query("SELECT * FROM task_def WHERE id = $1", [
      req.params.id,
    ]);
    if (!current.rowCount) throw httpError(404, "task_def not found");
    const expires =
      expires_after_days === "" || expires_after_days == null
        ? null
        : `${Number(expires_after_days)} days`;
    const { rows } = await pool.query(
      `
      UPDATE task_def
      SET name = COALESCE($2, name),
          type = COALESCE($3, type),
          expires_after = $4::interval,
          requires_approval = COALESCE($5, requires_approval),
          approver_roles = $6::role[]
      WHERE id = $1
      RETURNING id, name, type, config, expires_after::text AS expires_after, requires_approval, approver_roles::text[] AS approver_roles
      `,
      [
        req.params.id,
        name || null,
        type || null,
        expires,
        typeof requires_approval === "boolean"
          ? requires_approval
          : requires_approval === "true"
            ? true
            : requires_approval === "false"
              ? false
              : null,
        asRoleList(approver_roles),
      ]
    );
    res.json(rows[0]);
  })
);

app.get(
  "/api/workflow-defs",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `
      SELECT
        wd.id, wd.name, wd.code, wd.version, wd.status, wd.supersedes_id, wd.grants_role,
        COALESCE(
          json_agg(
            json_build_object(
              'id', wtd.id,
              'task_def_id', td.id,
              'task_name', td.name,
              'position', wtd.position,
              'required', wtd.required
            ) ORDER BY wtd.position
          ) FILTER (WHERE wtd.id IS NOT NULL),
          '[]'
        ) AS tasks
      FROM workflow_def wd
      LEFT JOIN workflow_task_def wtd ON wtd.workflow_def_id = wd.id
      LEFT JOIN task_def td ON td.id = wtd.task_def_id
      GROUP BY wd.id
      ORDER BY wd.code, wd.version
      `
    );
    res.json(rows);
  })
);

app.get(
  "/api/workflow-defs/:id",
  wrap(async (req, res) => {
    const def = await pool.query("SELECT * FROM workflow_def WHERE id = $1", [
      req.params.id,
    ]);
    if (!def.rowCount) throw httpError(404, "workflow_def not found");
    const tasks = await pool.query(
      `
      SELECT wtd.id, wtd.task_def_id, td.name AS task_name, wtd.position, wtd.required
      FROM workflow_task_def wtd
      JOIN task_def td ON td.id = wtd.task_def_id
      WHERE wtd.workflow_def_id = $1
      ORDER BY wtd.position
      `,
      [req.params.id]
    );
    res.json({ ...def.rows[0], tasks: tasks.rows });
  })
);

app.post(
  "/api/workflow-defs",
  wrap(async (req, res) => {
    const { code, name, grants_role } = req.body;
    if (!code || !name) throw httpError(400, "code and name required");
    const existing = await pool.query(
      "SELECT 1 FROM workflow_def WHERE code = $1 LIMIT 1",
      [code]
    );
    if (existing.rowCount) {
      throw httpError(409, "code already exists; use new version on that workflow");
    }
    const { rows } = await pool.query(
      `
      INSERT INTO workflow_def (name, code, version, status, grants_role)
      VALUES ($1, $2, 1, 'active', $3::role)
      RETURNING *
      `,
      [name, code, asRoleOrNull(grants_role)]
    );
    res.status(201).json(rows[0]);
  })
);

app.post(
  "/api/workflow-defs/:id/tasks",
  wrap(async (req, res) => {
    const { task_def_id, required } = req.body;
    if (!task_def_id) throw httpError(400, "task_def_id required");
    const def = await pool.query("SELECT * FROM workflow_def WHERE id = $1", [
      req.params.id,
    ]);
    if (!def.rowCount) throw httpError(404, "workflow_def not found");
    if (def.rows[0].status !== "active") {
      throw httpError(400, "cannot edit archived workflow_def; create a new version");
    }
    const pos = await pool.query(
      "SELECT COALESCE(MAX(position), 0) + 1 AS n FROM workflow_task_def WHERE workflow_def_id = $1",
      [req.params.id]
    );
    const { rows } = await pool.query(
      `
      INSERT INTO workflow_task_def (workflow_def_id, task_def_id, position, required)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        req.params.id,
        task_def_id,
        pos.rows[0].n,
        required === false || required === "false" ? false : true,
      ]
    );
    res.status(201).json(rows[0]);
  })
);

app.post(
  "/api/workflow-defs/:id/tasks/:slotId/delete",
  wrap(async (req, res) => {
    const def = await pool.query("SELECT * FROM workflow_def WHERE id = $1", [
      req.params.id,
    ]);
    if (!def.rowCount) throw httpError(404, "workflow_def not found");
    if (def.rows[0].status !== "active") {
      throw httpError(400, "cannot edit archived workflow_def");
    }
    const linked = await pool.query(
      "SELECT 1 FROM workflow_task_ins WHERE workflow_task_def_id = $1 LIMIT 1",
      [req.params.slotId]
    );
    if (linked.rowCount) {
      throw httpError(409, "slot already used by a workflow instance; create a new version");
    }
    const del = await pool.query(
      "DELETE FROM workflow_task_def WHERE id = $1 AND workflow_def_id = $2 RETURNING id",
      [req.params.slotId, req.params.id]
    );
    if (!del.rowCount) throw httpError(404, "slot not found");
    res.json({ ok: true });
  })
);

app.post(
  "/api/workflow-defs/:id/archive",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `
      UPDATE workflow_def
      SET status = 'archived'
      WHERE id = $1 AND status = 'active'
      RETURNING *
      `,
      [req.params.id]
    );
    if (!rows.length) throw httpError(400, "already archived or not found");
    res.json(rows[0]);
  })
);

app.post(
  "/api/workflow-defs/:id/new-version",
  wrap(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(
        "SELECT * FROM workflow_def WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );
      if (!cur.rowCount) throw httpError(404, "workflow_def not found");
      const old = cur.rows[0];
      if (old.status !== "active") {
        throw httpError(400, "can only version an active workflow_def");
      }
      await client.query(
        "UPDATE workflow_def SET status = 'archived' WHERE id = $1",
        [old.id]
      );
      const ver = await client.query(
        "SELECT COALESCE(MAX(version), 0) + 1 AS n FROM workflow_def WHERE code = $1",
        [old.code]
      );
      const created = await client.query(
        `
        INSERT INTO workflow_def (name, code, version, status, supersedes_id, grants_role)
        VALUES ($1, $2, $3, 'active', $4, $5)
        RETURNING *
        `,
        [old.name, old.code, ver.rows[0].n, old.id, old.grants_role]
      );
      await client.query(
        `
        INSERT INTO workflow_task_def (workflow_def_id, task_def_id, position, required)
        SELECT $1, task_def_id, position, required
        FROM workflow_task_def
        WHERE workflow_def_id = $2
        `,
        [created.rows[0].id, old.id]
      );
      const tasks = await client.query(
        `
        SELECT wtd.id, wtd.task_def_id, td.name AS task_name, wtd.position, wtd.required
        FROM workflow_task_def wtd
        JOIN task_def td ON td.id = wtd.task_def_id
        WHERE wtd.workflow_def_id = $1
        ORDER BY wtd.position
        `,
        [created.rows[0].id]
      );
      await client.query("COMMIT");
      res.status(201).json({ ...created.rows[0], tasks: tasks.rows });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/users/:id/workflows",
  wrap(async (req, res) => {
    const { workflow_def_id } = req.body;
    if (!workflow_def_id) throw httpError(400, "workflow_def_id required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query('SELECT id FROM "user" WHERE id = $1', [
        req.params.id,
      ]);
      if (!user.rowCount) throw httpError(404, "user not found");
      const def = await client.query(
        "SELECT * FROM workflow_def WHERE id = $1 FOR UPDATE",
        [workflow_def_id]
      );
      if (!def.rowCount) throw httpError(404, "workflow_def not found");
      if (def.rows[0].status !== "active") {
        throw httpError(400, "cannot assign archived workflow_def");
      }
      const wf = await client.query(
        `
        INSERT INTO workflow_ins (workflow_def_id, user_id, status, started_at, grants_role)
        VALUES ($1, $2, 'pending', now(), $3)
        RETURNING *
        `,
        [workflow_def_id, req.params.id, def.rows[0].grants_role]
      );
      const slots = await client.query(
        "SELECT * FROM workflow_task_def WHERE workflow_def_id = $1 ORDER BY position",
        [workflow_def_id]
      );
      for (const slot of slots.rows) {
        const taskIns = await findOrCreateTaskIns(
          client,
          req.params.id,
          slot.task_def_id
        );
        await client.query(
          `
          INSERT INTO workflow_task_ins (workflow_ins_id, task_ins_id, workflow_task_def_id)
          VALUES ($1, $2, $3)
          `,
          [wf.rows[0].id, taskIns.id, slot.id]
        );
      }
      await maybeCompleteWorkflow(client, wf.rows[0].id);
      const out = await client.query(
        "SELECT * FROM workflow_ins WHERE id = $1",
        [wf.rows[0].id]
      );
      await client.query("COMMIT");
      res.status(201).json(out.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/task-ins/:id/complete",
  wrap(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query(
        `
        SELECT ti.*, td.expires_after
        FROM task_ins ti
        JOIN task_def td ON td.id = ti.task_def_id
        WHERE ti.id = $1
        FOR UPDATE OF ti
        `,
        [req.params.id]
      );
      if (!task.rowCount) throw httpError(404, "task_ins not found");
      if (task.rows[0].status === "completed") {
        throw httpError(400, "already completed");
      }
      const updated = await client.query(
        `
        UPDATE task_ins
        SET status = 'completed',
            completed_at = now(),
            expires_at = CASE
              WHEN $2::interval IS NULL THEN NULL
              ELSE now() + $2::interval
            END
        WHERE id = $1
        RETURNING *
        `,
        [req.params.id, task.rows[0].expires_after]
      );
      const linked = await client.query(
        "SELECT workflow_ins_id FROM workflow_task_ins WHERE task_ins_id = $1",
        [req.params.id]
      );
      for (const row of linked.rows) {
        await maybeCompleteWorkflow(client, row.workflow_ins_id);
      }
      await client.query("COMMIT");
      res.json(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/task-ins/:id/expire",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `
      UPDATE task_ins
      SET status = 'expired'
      WHERE id = $1 AND status = 'completed'
      RETURNING *
      `,
      [req.params.id]
    );
    if (!rows.length) throw httpError(400, "only a completed task_ins can expire");
    res.json(rows[0]);
  })
);

app.use((err, _req, res, _next) => {
  if (err.code === "22P02") {
    return res.status(400).json({ error: "invalid role: " + err.message });
  }
  if (err.code === "23505") {
    return res.status(409).json({ error: "unique constraint: " + err.detail });
  }
  if (err.code === "23503") {
    return res.status(400).json({ error: "fk constraint: " + err.detail });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "server error" });
});

async function main() {
  await migrate();
  app.listen(PORT, "0.0.0.0", () => {
    console.log("listening on", PORT);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
