/**
 * Compatibility facade for contact-approval helpers.
 *
 * Query construction and writes live in access/repo.ts; this file keeps the
 * existing import path for callers while staying out of the DB boundary.
 */
export {
  deriveRequiresContactApproval,
  deriveRequiresContactApprovalMany,
  grantApprovedContactVisibility,
  setRequiresContactApproval,
} from "./repo.js"
