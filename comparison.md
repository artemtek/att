# Schema comparison: att vs prototype-att

Reference as of 2026-08-27. **att** is ours (`db/migrations/001_init.sql`). **prototype-att** is the DAME “ours” design.

## Same kernel

Both dedup with unique `(user, task_def)` and keep task work **off** the workflow row. Completing a shared task once is visible to every workflow that includes it. Workflow instances pin to a def id (archive-and-create for versions).

## What att has now

Roles are in. They are a Postgres **enum + arrays**, not a `role` table.

- Enum: `researcher` | `pi` | `data_reviewer` | `whitelister`
- `user.roles role[]` — live RBAC
- `workflow_def.grants_role` — optional; copied onto `workflow_ins` at assign
- `task_def.requires_approval` + `approver_roles role[]`
- One **pending** run per `(user, grants_role)` when `grants_role` is not null

A workflow **may** grant a role. It is **not** identified by a role.

## The real fork

| | att (ours) | prototype-att |
|---|---|---|
| Workflow identity | `code` + `version` | **is** a role |
| Membership of a run | stored `workflow_task_ins` | derived from pinned def’s task list |
| Roles | `role` enum, `user.roles role[]` | untyped `TEXT[]` + `role_auth_links` |
| Grant | optional `grants_role` on def/ins | finishing the role-workflow *is* the grant |
| Task types | free `type` + `config` JSON | `document` \| `acknowledgement` + template/file/signature |
| Status | pending/completed (+ task expired) | review / approve / whitelist machine |
| One-at-a-time | one **pending** per grant (nullable) | one **active** def per role, one **active** ins per `(user, role)` |

## att — wins

- Multiple concurrent packages that are not roles (recert, shared DUA pack).
- Assignment snapshot: old runs keep their slots if a def is edited.
- Typed roles; invalid values fail at the DB.
- `required` per slot; explicit `version` / `supersedes_id`.
- Grant is a field, not the primary key of the template.

## prototype-att — wins

- Smaller: no junction, enroll is one insert, checklist is a join.
- Product fields att still does not have as columns: whitelist, file, signature, decision, task archive, `valid_for_days`.
- Status is recomputed through approval, not just done/not-done.
- `role_auth_links` maps RBAC → auth group for real provisioning.

## Verdict

att is the better **generic engine** (overlap + snapshot + roles as a side effect). prototype-att is the better **DAME onboarding app** (role *is* the track, approval/whitelist in the model).

Steal from prototype-att when needed: whitelist, submit/approve on `task_ins`, file/signature, archive on `task_def`. Do **not** steal “workflow = role” — att avoided that on purpose.

## Table mapping

| att | prototype-att |
|---|---|
| `task_def` | `task_definitions` |
| `workflow_def` | `workflow_definitions` |
| `workflow_task_def` | `workflow_definition_tasks` |
| `workflow_ins` | `workflow_instances` |
| `task_ins` | `task_instances` |
| `workflow_task_ins` | *(none — derived)* |
| `role` enum + `user.roles` | `user.roles TEXT[]` + `role_auth_links` |
