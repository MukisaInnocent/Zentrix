export const STAFF_ROLES = ['support', 'reviewer', 'finance', 'compliance', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type Role = 'member' | 'advertiser' | StaffRole;

export const isStaffRole = (role: string): role is StaffRole => (STAFF_ROLES as readonly string[]).includes(role);

// What the session middleware attaches to req.auth for a signed-in request.
export interface AuthContext {
  sessionId: number;
  userId: number;
  publicId: string;
  username: string;
  roles: Role[];
  isStaff: boolean;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  status: 'active' | 'frozen' | 'closed';
  countryCode: string;
  currencyCode: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  csrfToken: string;
}
