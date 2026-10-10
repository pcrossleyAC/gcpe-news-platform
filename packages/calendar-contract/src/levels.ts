/** Calendar levels, as legacy's SecurityRole enum. Every check is "level ≥ n" (spec addendum §4).
 * A mirror of @gcpe/auth's CALENDAR_LEVELS, which browser code can't import; a test keeps them equal. */
export const LEVEL = { readOnly: 1, editor: 2, advanced: 3, administrator: 4, sysAdmin: 5 } as const;
