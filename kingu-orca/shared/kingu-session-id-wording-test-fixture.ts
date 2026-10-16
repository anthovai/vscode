/**
 * Agent-read text that calls an Kingu session ID an "address". The noun only: "address it by that"
 * is a verb, and `run:`/`dispatch:`/group addresses are mailboxes, not this identity.
 */
export const KINGU_SESSION_ID_AS_ADDRESS =
  /\b(?:orchestration|session|Kingu|coordinator's|your(?: own)?) address\b|caller\.address|naming its address/i
