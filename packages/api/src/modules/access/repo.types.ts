import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"

/**
 * Repo-boundary type aliases for the access module (guard r2: only repo*.ts /
 * repo.types.ts may reference the Kysely `TableRow`/`TableInsert`/`TableUpdate`
 * aliases). Non-repo helpers import these named types instead of touching the
 * raw Kysely aliases directly.
 */

/** Insert shape for the `resource_access_bindings` junction table. */
export type ResourceAccessBindingInsert = TableInsert<"resourceAccessBindings">

/** Selected-row shape for the `access_subjects` registry table. */
export type AccessSubjectRow = TableRow<"accessSubjects">
