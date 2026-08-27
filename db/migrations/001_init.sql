CREATE TYPE role AS ENUM (
  'researcher',
  'pi',
  'data_reviewer',
  'whitelister'
);

CREATE TABLE "user" (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  roles role[] NOT NULL DEFAULT '{}'
);
CREATE INDEX user_roles_gin ON "user" USING GIN (roles);

CREATE TABLE task_def (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'attest',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_after INTERVAL,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approver_roles role[] NOT NULL DEFAULT '{}'
);

CREATE TABLE workflow_def (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  supersedes_id INT REFERENCES workflow_def(id),
  grants_role role,
  UNIQUE (code, version)
);

CREATE TABLE workflow_task_def (
  id SERIAL PRIMARY KEY,
  workflow_def_id INT NOT NULL REFERENCES workflow_def(id),
  task_def_id INT NOT NULL REFERENCES task_def(id),
  position INT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (workflow_def_id, task_def_id)
);

CREATE TABLE workflow_ins (
  id SERIAL PRIMARY KEY,
  workflow_def_id INT NOT NULL REFERENCES workflow_def(id),
  user_id INT NOT NULL REFERENCES "user"(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  grants_role role
);
CREATE UNIQUE INDEX workflow_ins_one_open_per_grant
  ON workflow_ins (user_id, grants_role)
  WHERE status = 'pending' AND grants_role IS NOT NULL;

CREATE TABLE task_ins (
  id SERIAL PRIMARY KEY,
  task_def_id INT NOT NULL REFERENCES task_def(id),
  user_id INT NOT NULL REFERENCES "user"(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CONSTRAINT task_ins_user_task_def_uk UNIQUE (user_id, task_def_id)
);

CREATE TABLE workflow_task_ins (
  id SERIAL PRIMARY KEY,
  workflow_ins_id INT NOT NULL REFERENCES workflow_ins(id),
  task_ins_id INT NOT NULL REFERENCES task_ins(id),
  workflow_task_def_id INT NOT NULL REFERENCES workflow_task_def(id),
  CONSTRAINT workflow_task_ins_workflow_slot_uk UNIQUE (workflow_ins_id, workflow_task_def_id)
);

CREATE INDEX workflow_ins_user_id_idx ON workflow_ins (user_id);
CREATE INDEX task_ins_user_id_idx ON task_ins (user_id);
CREATE INDEX workflow_task_ins_task_ins_id_idx ON workflow_task_ins (task_ins_id);
