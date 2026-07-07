/**
 * Guest scoping (spec §5.1 "External Agency Partner — scoped collaboration on
 * specific campaigns" / §13 "scoped guest access for agencies"). Attribute-based
 * access in miniature: guests see and touch ONLY the campaigns an admin has
 * explicitly assigned. Internal roles are unaffected.
 */

/** Roles whose access is campaign-scoped rather than global. */
const GUEST_ROLES = new Set(["agency-partner"]);

export class GuestAccess {
  private readonly assignments = new Set<string>();

  isGuestRole(roleId: string | undefined): boolean {
    return roleId !== undefined && GUEST_ROLES.has(roleId);
  }

  /** True when this role may access the campaign (non-guests always may). */
  isAllowed(roleId: string | undefined, campaignId: string): boolean {
    if (!this.isGuestRole(roleId)) return true;
    return this.assignments.has(campaignId);
  }

  assign(campaignId: string): void {
    this.assignments.add(campaignId);
  }

  revoke(campaignId: string): void {
    this.assignments.delete(campaignId);
  }

  /** Campaign ids currently assigned to guests (Admin console). */
  list(): string[] {
    return [...this.assignments];
  }
}
