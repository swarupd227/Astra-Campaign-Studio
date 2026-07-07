/**
 * Back-compat entry point. The agent catalogue now lives in `catalogue.ts`
 * (grouped by stage). This module re-exports it so existing imports keep working.
 */
export * from "./catalogue";
