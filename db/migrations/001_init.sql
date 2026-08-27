-- Approbo replacement sketch for DAME (same DB later).
-- Reuses DAME users + user_role. Does NOT put roles on users (those come from auth).
-- Prototype-only: user_auth_roles stands in for auth groups.

CREATE TYPE user_role AS ENUM (
  'scientific_access_researcher',
  'scientific_access_pi',
  'scientific_access_feedback_committee_member',
  'scientific_access_feedback_committee_chair',
  'legal_rep_institutional_contract_representative',
  'legal_rep_cadr_iso_cadr_iso',
  'legal_rep_institutional_data_reviewer',
  'legal_rep_ncats_contractual_rep',
  'legal_rep_dac_secretary',
  'legal_rep_institutional_whitelister',
  'legal_rep_dac_committee_member',
  'legal_rep_dac_committee_chair',
  'legal_rep_n3c_operational_support_admin',
  'legal_rep_n3c_operational_support_super_admin',
  'contractual_access_regenstrief'
);

CREATE TYPE task_def_type AS ENUM ('document', 'acknowledgement');
CREATE TYPE workflow_def_status AS ENUM ('active', 'archived');
CREATE TYPE workflow_ins_status AS ENUM (
  'awaiting_documents',
  'under_review',
  'awaiting_approval',
  'approved',
  'rejected',
  'completed',
  'archived'
);
CREATE TYPE task_ins_status AS ENUM (
  'pending',
  'submitted',
  'approved',
  'rejected',
  'completed',
  'expired'
);
CREATE TYPE approval_decision AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE role_request_status AS ENUM ('pending', 'approved', 'rejected', 'granted');

-- Stub of dame.users (full_name, not name). No roles column.
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL
);

-- Prototype-only stand-in for auth groups. Does not ship to DAME.
CREATE TABLE user_auth_roles (
  user_id INT NOT NULL REFERENCES users(id),
  role user_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE role_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  requested_role user_role,
  approved_role user_role,
  status role_request_status NOT NULL DEFAULT 'pending'
);

CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name TEXT NOT NULL
);

CREATE TABLE task_def (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type task_def_type NOT NULL DEFAULT 'acknowledgement',
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approver_roles user_role[] NOT NULL DEFAULT '{}',
  valid_for_days INT,
  requires_completion_date BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ
);

CREATE TABLE workflow_def (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  version INT NOT NULL,
  status workflow_def_status NOT NULL,
  supersedes_id INT REFERENCES workflow_def(id),
  grants_role user_role,
  requires_whitelisting BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX workflow_def_one_active_per_grant
  ON workflow_def (grants_role)
  WHERE status = 'active' AND grants_role IS NOT NULL;

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
  user_id INT NOT NULL REFERENCES users(id),
  role_request_id INT REFERENCES role_requests(id),
  grants_role user_role,
  status workflow_ins_status NOT NULL DEFAULT 'awaiting_documents',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  whitelisted_by_user_id INT REFERENCES users(id),
  whitelisted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX workflow_ins_one_open_per_grant
  ON workflow_ins (user_id, grants_role)
  WHERE archived_at IS NULL
    AND grants_role IS NOT NULL
    AND status NOT IN ('completed', 'rejected', 'archived');

CREATE TABLE task_ins (
  id SERIAL PRIMARY KEY,
  task_def_id INT NOT NULL REFERENCES task_def(id),
  user_id INT NOT NULL REFERENCES users(id),
  status task_ins_status NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  training_completed_at DATE,
  CONSTRAINT task_ins_user_task_def_uk UNIQUE (user_id, task_def_id)
);

CREATE TABLE workflow_task_ins (
  id SERIAL PRIMARY KEY,
  workflow_ins_id INT NOT NULL REFERENCES workflow_ins(id),
  task_ins_id INT NOT NULL REFERENCES task_ins(id),
  workflow_task_def_id INT NOT NULL REFERENCES workflow_task_def(id),
  CONSTRAINT workflow_task_ins_workflow_slot_uk UNIQUE (workflow_ins_id, workflow_task_def_id)
);

CREATE TABLE task_ins_document (
  id SERIAL PRIMARY KEY,
  task_ins_id INT NOT NULL REFERENCES task_ins(id),
  file_id UUID REFERENCES files(id),
  signature_name TEXT,
  signed_at TIMESTAMPTZ
);

CREATE TABLE task_ins_approval (
  id SERIAL PRIMARY KEY,
  task_ins_id INT NOT NULL REFERENCES task_ins(id),
  approver_user_id INT REFERENCES users(id),
  decision approval_decision NOT NULL DEFAULT 'pending',
  comment TEXT,
  decided_at TIMESTAMPTZ
);

CREATE INDEX workflow_ins_user_id_idx ON workflow_ins (user_id);
CREATE INDEX task_ins_user_id_idx ON task_ins (user_id);
CREATE INDEX workflow_task_ins_task_ins_id_idx ON workflow_task_ins (task_ins_id);
CREATE INDEX role_requests_user_id_idx ON role_requests (user_id);
