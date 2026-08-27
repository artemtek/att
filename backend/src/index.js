const express = require("express");
const { pool } = require("./db");
const { migrate } = require("./migrate");

const PORT = Number(process.env.PORT || 3000);
const WHITELISTER = "legal_rep_institutional_whitelister";
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
function hasAnyRole(userRoles, allowed) {
  const set = new Set(userRoles || []);
  return (allowed || []).some((r) => set.has(r));
}
function isExpired(row) {
  if (row.status === "expired") return true;
  if (!row.expires_at) return false;
  return new Date(row.expires_at).getTime() < Date.now();
}
function taskDone(td, ti) {
  if (!ti || isExpired(ti)) return false;
  return td.requires_approval ? ti.status === "approved" : ti.status === "completed";
}
function docsIn(ti) {
  if (!ti || isExpired(ti)) return false;
  return ["submitted", "approved", "completed"].includes(ti.status);
}

async function userRoles(client, userId) {
  const { rows } = await client.query(
    "SELECT role::text AS role FROM user_auth_roles WHERE user_id = $1 ORDER BY role",
    [userId]
  );
  return rows.map((r) => r.role);
}

async function grantRole(client, userId, role) {
  if (!role) return;
  await client.query(
    "INSERT INTO user_auth_roles (user_id, role) VALUES ($1, $2::user_role) ON CONFLICT DO NOTHING",
    [userId, role]
  );
}

async function findOrCreateTaskIns(client, userId, taskDefId) {
  const existing = await client.query(
    "SELECT * FROM task_ins WHERE user_id = $1 AND task_def_id = $2",
    [userId, taskDefId]
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (isExpired(row)) {
      const reopened = await client.query(
        `
        UPDATE task_ins
        SET status = 'pending', completed_at = NULL, expires_at = NULL,
            training_completed_at = NULL, started_at = now()
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

async function recomputeInstance(client, instanceId) {
  const instRes = await client.query(
    "SELECT * FROM workflow_ins WHERE id = $1 FOR UPDATE",
    [instanceId]
  );
  if (!instRes.rowCount) return;
  const inst = instRes.rows[0];
  if (inst.archived_at || inst.status === "archived") return;

  const def = await client.query(
    "SELECT requires_whitelisting FROM workflow_def WHERE id = $1",
    [inst.workflow_def_id]
  );
  const requiresWhitelisting = def.rows[0]?.requires_whitelisting;

  const slots = await client.query(
    `
    SELECT wtd.required, td.requires_approval, ti.status, ti.expires_at
    FROM workflow_task_ins wti
    JOIN workflow_task_def wtd ON wtd.id = wti.workflow_task_def_id
    JOIN task_def td ON td.id = wtd.task_def_id
    JOIN task_ins ti ON ti.id = wti.task_ins_id
    WHERE wti.workflow_ins_id = $1
    `,
    [instanceId]
  );

  const required = slots.rows.filter((s) => s.required);
  const anyRejected = required.some((s) => s.status === "rejected" && !isExpired(s));
  const allDone = required.every((s) =>
    taskDone({ requires_approval: s.requires_approval }, s)
  );
  const allDocsIn = required.every((s) => docsIn(s));

  let status;
  if (anyRejected) {
    status = "rejected";
  } else if (allDone) {
    if (requiresWhitelisting && !inst.whitelisted_at) {
      status = "awaiting_approval";
    } else {
      await grantRole(client, inst.user_id, inst.grants_role);
      if (inst.role_request_id) {
        await client.query(
          "UPDATE role_requests SET status = 'granted', approved_role = $2 WHERE id = $1",
          [inst.role_request_id, inst.grants_role]
        );
      }
      status = "completed";
    }
  } else if (allDocsIn) {
    status = "under_review";
  } else {
    status = "awaiting_documents";
  }

  const extra =
    status === "completed"
      ? ", completed_at = COALESCE(completed_at, now())"
      : "";
  await client.query(
    `UPDATE workflow_ins SET status = $2${extra} WHERE id = $1`,
    [inst.id, status]
  );
  return status;
}

async function recomputeAffected(client, userId, taskDefId) {
  const { rows } = await client.query(
    `
    SELECT DISTINCT wti.workflow_ins_id
    FROM workflow_task_ins wti
    JOIN task_ins ti ON ti.id = wti.task_ins_id
    JOIN workflow_ins wi ON wi.id = wti.workflow_ins_id
    WHERE ti.user_id = $1 AND ti.task_def_id = $2 AND wi.archived_at IS NULL
    `,
    [userId, taskDefId]
  );
  for (const r of rows) await recomputeInstance(client, r.workflow_ins_id);
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get(
  "/api/roles",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `
      SELECT e.enumlabel AS role
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'user_role'
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
      `
      SELECT u.id, u.email, u.full_name,
             COALESCE(
               ARRAY_AGG(uar.role::text ORDER BY uar.role) FILTER (WHERE uar.role IS NOT NULL),
               '{}'
             ) AS roles
      FROM users u
      LEFT JOIN user_auth_roles uar ON uar.user_id = u.id
      GROUP BY u.id
      ORDER BY u.id
      `
    );
    res.json(rows);
  })
);

app.post(
  "/api/users",
  wrap(async (req, res) => {
    const { email, full_name, name, roles } = req.body;
    const fullName = full_name || name;
    if (!email || !fullName) throw httpError(400, "email and full_name required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id, email, full_name",
        [email, fullName]
      );
      for (const role of asRoleList(roles)) {
        await grantRole(client, rows[0].id, role);
      }
      await client.query("COMMIT");
      const granted = await userRoles(pool, rows[0].id);
      res.status(201).json({ ...rows[0], roles: granted });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/users/:id/roles",
  wrap(async (req, res) => {
    const roles = asRoleList(req.body.roles);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query("SELECT id FROM users WHERE id = $1", [
        req.params.id,
      ]);
      if (!user.rowCount) throw httpError(404, "user not found");
      await client.query("DELETE FROM user_auth_roles WHERE user_id = $1", [
        req.params.id,
      ]);
      for (const role of roles) await grantRole(client, req.params.id, role);
      await client.query("COMMIT");
      const u = await pool.query(
        "SELECT id, email, full_name FROM users WHERE id = $1",
        [req.params.id]
      );
      res.json({ ...u.rows[0], roles });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/api/users/:id",
  wrap(async (req, res) => {
    const user = await pool.query(
      "SELECT id, email, full_name FROM users WHERE id = $1",
      [req.params.id]
    );
    if (!user.rowCount) throw httpError(404, "user not found");
    const roles = await userRoles(pool, req.params.id);

    const workflowIns = await pool.query(
      `
      SELECT
        wi.id, wi.status, wi.started_at, wi.completed_at, wi.archived_at,
        wi.workflow_def_id, wi.grants_role, wi.role_request_id,
        wi.whitelisted_at, wi.whitelisted_by_user_id,
        wd.code, wd.version, wd.name AS workflow_name, wd.status AS workflow_def_status,
        wd.requires_whitelisting
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
            wti.workflow_ins_id, wtd.position, wtd.required,
            ti.id AS task_ins_id, ti.status AS task_ins_status,
            ti.expires_at, ti.completed_at, ti.training_completed_at,
            td.id AS task_def_id, td.name AS task_name, td.type,
            td.requires_approval
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
    for (const s of slots.rows) (slotsByWf[s.workflow_ins_id] ||= []).push(s);

    const taskIns = await pool.query(
      `
      SELECT
        ti.id, ti.status, ti.started_at, ti.completed_at, ti.expires_at,
        ti.training_completed_at,
        td.id AS task_def_id, td.name AS task_name, td.type,
        td.requires_approval, td.valid_for_days, td.requires_completion_date,
        td.approver_roles::text[] AS approver_roles,
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
      user: { ...user.rows[0], roles },
      workflow_ins: workflowIns.rows.map((w) => ({
        ...w,
        tasks: slotsByWf[w.id] || [],
      })),
      task_ins: taskIns.rows,
    });
  })
);

const TASK_DEF_SELECT = `
  id, name, description, type, requires_approval,
  approver_roles::text[] AS approver_roles, valid_for_days,
  requires_completion_date, archived_at
`;

app.get(
  "/api/task-defs",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT ${TASK_DEF_SELECT} FROM task_def WHERE archived_at IS NULL ORDER BY id`
    );
    res.json(rows);
  })
);

app.get(
  "/api/task-defs/:id",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${TASK_DEF_SELECT} FROM task_def WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) throw httpError(404, "task_def not found");
    res.json(rows[0]);
  })
);

app.post(
  "/api/task-defs",
  wrap(async (req, res) => {
    const {
      name,
      description,
      type,
      requires_approval,
      approver_roles,
      valid_for_days,
      requires_completion_date,
    } = req.body;
    if (!name) throw httpError(400, "name required");
    const { rows } = await pool.query(
      `
      INSERT INTO task_def
        (name, description, type, requires_approval, approver_roles, valid_for_days, requires_completion_date)
      VALUES ($1, $2, $3::task_def_type, $4, $5::user_role[], $6, $7)
      RETURNING ${TASK_DEF_SELECT}
      `,
      [
        name,
        description || null,
        type || "acknowledgement",
        requires_approval === true || requires_approval === "true",
        asRoleList(approver_roles),
        valid_for_days === "" || valid_for_days == null ? null : Number(valid_for_days),
        requires_completion_date === true || requires_completion_date === "true",
      ]
    );
    res.status(201).json(rows[0]);
  })
);

app.post(
  "/api/task-defs/:id",
  wrap(async (req, res) => {
    const current = await pool.query("SELECT id FROM task_def WHERE id = $1", [
      req.params.id,
    ]);
    if (!current.rowCount) throw httpError(404, "task_def not found");
    const {
      name,
      description,
      type,
      requires_approval,
      approver_roles,
      valid_for_days,
      requires_completion_date,
    } = req.body;
    const { rows } = await pool.query(
      `
      UPDATE task_def SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        type = COALESCE($4::task_def_type, type),
        requires_approval = COALESCE($5, requires_approval),
        approver_roles = $6::user_role[],
        valid_for_days = $7,
        requires_completion_date = COALESCE($8, requires_completion_date)
      WHERE id = $1
      RETURNING ${TASK_DEF_SELECT}
      `,
      [
        req.params.id,
        name || null,
        description ?? null,
        type || null,
        typeof requires_approval === "boolean"
          ? requires_approval
          : requires_approval === "true"
            ? true
            : requires_approval === "false"
              ? false
              : null,
        asRoleList(approver_roles),
        valid_for_days === "" || valid_for_days == null ? null : Number(valid_for_days),
        typeof requires_completion_date === "boolean"
          ? requires_completion_date
          : requires_completion_date === "true"
            ? true
            : requires_completion_date === "false"
              ? false
              : null,
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
        wd.id, wd.name, wd.code, wd.version, wd.status, wd.supersedes_id,
        wd.grants_role, wd.requires_whitelisting,
        COALESCE(
          json_agg(
            json_build_object(
              'id', wtd.id, 'task_def_id', td.id, 'task_name', td.name,
              'position', wtd.position, 'required', wtd.required
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
    const { code, name, grants_role, requires_whitelisting } = req.body;
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
      INSERT INTO workflow_def (name, code, version, status, grants_role, requires_whitelisting)
      VALUES ($1, $2, 1, 'active', $3::user_role, $4)
      RETURNING *
      `,
      [
        name,
        code,
        asRoleOrNull(grants_role),
        requires_whitelisting === true || requires_whitelisting === "true",
      ]
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
      UPDATE workflow_def SET status = 'archived'
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
        INSERT INTO workflow_def
          (name, code, version, status, supersedes_id, grants_role, requires_whitelisting)
        VALUES ($1, $2, $3, 'active', $4, $5, $6)
        RETURNING *
        `,
        [
          old.name,
          old.code,
          ver.rows[0].n,
          old.id,
          old.grants_role,
          old.requires_whitelisting,
        ]
      );
      await client.query(
        `
        INSERT INTO workflow_task_def (workflow_def_id, task_def_id, position, required)
        SELECT $1, task_def_id, position, required
        FROM workflow_task_def WHERE workflow_def_id = $2
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
      const user = await client.query("SELECT id FROM users WHERE id = $1", [
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
      let roleRequestId = null;
      if (def.rows[0].grants_role) {
        const rr = await client.query(
          `
          INSERT INTO role_requests (user_id, requested_role, status)
          VALUES ($1, $2, 'pending')
          RETURNING id
          `,
          [req.params.id, def.rows[0].grants_role]
        );
        roleRequestId = rr.rows[0].id;
      }
      const wf = await client.query(
        `
        INSERT INTO workflow_ins
          (workflow_def_id, user_id, role_request_id, grants_role, status, started_at)
        VALUES ($1, $2, $3, $4, 'awaiting_documents', now())
        RETURNING *
        `,
        [workflow_def_id, req.params.id, roleRequestId, def.rows[0].grants_role]
      );
      const slotRows = await client.query(
        "SELECT * FROM workflow_task_def WHERE workflow_def_id = $1 ORDER BY position",
        [workflow_def_id]
      );
      for (const slot of slotRows.rows) {
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
      await recomputeInstance(client, wf.rows[0].id);
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
  "/api/task-ins/:id/submit",
  wrap(async (req, res) => {
    const { signature_name, file_name, training_completed_at } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query(
        `
        SELECT ti.*, td.requires_approval, td.type, td.valid_for_days, td.requires_completion_date
        FROM task_ins ti
        JOIN task_def td ON td.id = ti.task_def_id
        WHERE ti.id = $1
        FOR UPDATE OF ti
        `,
        [req.params.id]
      );
      if (!task.rowCount) throw httpError(404, "task_ins not found");
      const t = task.rows[0];
      if (t.requires_completion_date && !training_completed_at) {
        throw httpError(400, "training_completed_at required");
      }
      if (t.type === "document" && !file_name) {
        throw httpError(400, "file_name required for a document task");
      }
      const status = t.requires_approval ? "submitted" : "completed";
      const expiresSql =
        t.valid_for_days == null
          ? null
          : `${Number(t.valid_for_days)} days`;
      const updated = await client.query(
        `
        UPDATE task_ins SET
          status = $2,
          completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END,
          expires_at = CASE
            WHEN $3::interval IS NULL THEN NULL
            ELSE now() + $3::interval
          END,
          training_completed_at = $4
        WHERE id = $1
        RETURNING *
        `,
        [req.params.id, status, expiresSql, training_completed_at || null]
      );
      if (file_name || signature_name) {
        let fileId = null;
        if (file_name) {
          const f = await client.query(
            "INSERT INTO files (original_name) VALUES ($1) RETURNING id",
            [file_name]
          );
          fileId = f.rows[0].id;
        }
        await client.query(
          `
          INSERT INTO task_ins_document (task_ins_id, file_id, signature_name, signed_at)
          VALUES ($1, $2, $3, now())
          `,
          [req.params.id, fileId, signature_name || null]
        );
      }
      await recomputeAffected(client, t.user_id, t.task_def_id);
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
      UPDATE task_ins SET status = 'expired'
      WHERE id = $1 AND status IN ('completed', 'approved')
      RETURNING *
      `,
      [req.params.id]
    );
    if (!rows.length) throw httpError(400, "only a completed/approved task_ins can expire");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await recomputeAffected(client, rows[0].user_id, rows[0].task_def_id);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    res.json(rows[0]);
  })
);

app.post(
  "/api/task-ins/:id/decide",
  wrap(async (req, res) => {
    const { approverUserId, decision, comment } = req.body;
    if (!approverUserId || !["approved", "rejected"].includes(decision)) {
      throw httpError(400, "approverUserId and decision (approved|rejected) required");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tiRes = await client.query(
        `
        SELECT ti.*, td.requires_approval, td.approver_roles::text[] AS approver_roles
        FROM task_ins ti
        JOIN task_def td ON td.id = ti.task_def_id
        WHERE ti.id = $1
        FOR UPDATE OF ti
        `,
        [req.params.id]
      );
      if (!tiRes.rowCount) throw httpError(404, "task_ins not found");
      const ti = tiRes.rows[0];
      if (!ti.requires_approval) throw httpError(400, "task does not require approval");
      if (ti.status !== "submitted") throw httpError(400, "task is not awaiting approval");
      const roles = await userRoles(client, approverUserId);
      if (!hasAnyRole(roles, ti.approver_roles)) {
        throw httpError(403, "approver lacks an eligible role (checked live from user_auth_roles)");
      }
      const updated = await client.query(
        `UPDATE task_ins SET status = $2 WHERE id = $1 RETURNING *`,
        [req.params.id, decision]
      );
      await client.query(
        `
        INSERT INTO task_ins_approval (task_ins_id, approver_user_id, decision, comment, decided_at)
        VALUES ($1, $2, $3::approval_decision, $4, now())
        `,
        [req.params.id, approverUserId, decision, comment || null]
      );
      await recomputeAffected(client, ti.user_id, ti.task_def_id);
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
  "/api/workflow-ins/:id/whitelist",
  wrap(async (req, res) => {
    const { approverUserId, decision } = req.body;
    if (!approverUserId || !["approved", "rejected"].includes(decision)) {
      throw httpError(400, "approverUserId and decision (approved|rejected) required");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inst = await client.query(
        "SELECT * FROM workflow_ins WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );
      if (!inst.rowCount) throw httpError(404, "workflow_ins not found");
      if (inst.rows[0].status !== "awaiting_approval") {
        throw httpError(400, "workflow is not awaiting whitelist");
      }
      const roles = await userRoles(client, approverUserId);
      if (!roles.includes(WHITELISTER)) {
        throw httpError(403, "approver is not a whitelister");
      }
      if (decision === "rejected") {
        await client.query(
          "UPDATE workflow_ins SET status = 'rejected' WHERE id = $1",
          [req.params.id]
        );
      } else {
        await client.query(
          `
          UPDATE workflow_ins
          SET whitelisted_by_user_id = $2, whitelisted_at = now()
          WHERE id = $1
          `,
          [req.params.id, approverUserId]
        );
        await recomputeInstance(client, req.params.id);
      }
      const out = await client.query(
        "SELECT * FROM workflow_ins WHERE id = $1",
        [req.params.id]
      );
      await client.query("COMMIT");
      res.json(out.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/api/certifications",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `
      SELECT ti.id, ti.status, ti.user_id, u.full_name, u.email,
             td.name AS task_name, td.approver_roles::text[] AS approver_roles
      FROM task_ins ti
      JOIN task_def td ON td.id = ti.task_def_id
      JOIN users u ON u.id = ti.user_id
      WHERE ti.status = 'submitted' AND td.requires_approval
      ORDER BY ti.id
      `
    );
    res.json(rows);
  })
);

app.get(
  "/api/whitelisting",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `
      SELECT wi.id, wi.status, wi.user_id, wi.grants_role,
             u.full_name, u.email, wd.name AS workflow_name, wd.code
      FROM workflow_ins wi
      JOIN users u ON u.id = wi.user_id
      JOIN workflow_def wd ON wd.id = wi.workflow_def_id
      WHERE wi.status = 'awaiting_approval' AND wi.archived_at IS NULL
      ORDER BY wi.id
      `
    );
    res.json(rows);
  })
);

app.use((err, _req, res, _next) => {
  if (err.code === "22P02") {
    return res.status(400).json({ error: "invalid enum value: " + err.message });
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
  app.listen(PORT, "0.0.0.0", () => console.log("listening on", PORT));
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
