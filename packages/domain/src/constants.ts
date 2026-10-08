/**
 * Domain vocabulary, ported VERBATIM from release 3.1 (00_Config.gs,
 * 06_RBAC.gs, 15_Inspections.gs, 21_Admin.gs, 26_Notifications.gs).
 *
 * Nothing here is a new business rule. Where 3.1 kept a value in a sheet
 * (grade percentages, inspection impacts, commission rates, prices) the
 * value lives in the database and only the DEFAULT is repeated here.
 */

export const PLATFORM_NAME = 'Qatar Mobile';
export const PLATFORM_CODE = 'QM';
export const CURRENCY = 'QAR';
export const TIMEZONE = 'Asia/Qatar';
export const COUNTRY_CODE = '+974';
export const APP_VERSION = '4.1.0-staging';

/** Fallback only — "and if no commission rule matches at all?" (CFG.DEFAULT_COMMISSION_RATE). */
export const DEFAULT_COMMISSION_RATE = '0.05';

export const TRADEIN_CONFIG = {
  REQUIRE_IMEI: true,
  REQUIRE_IMEI_LUHN: true,
  REQUIRE_IMEI_MATCH: true,
  REQUIRE_SERIAL: false,
  ALLOW_ZERO_VALUE: true,
  BLOCK_ON_ACTIVATION_LOCK: true,
  ALLOW_CANCEL_AFTER_RECEIPT: false,
  TRACK_WINDOW_DAYS: 30,
} as const;

/* ------------------------------------------------------------------ roles */

export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  QM_ADMIN: 'QM_ADMIN',
  TECHNICIAN: 'TECHNICIAN',
  VENDOR_ADMIN: 'VENDOR_ADMIN',
  VENDOR_MANAGER: 'VENDOR_MANAGER',
  VENDOR_STAFF: 'VENDOR_STAFF',
  CUSTOMER: 'CUSTOMER',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];
export type StaffRole = Exclude<Role, 'CUSTOMER'>;

export const PLATFORM_ROLES: readonly Role[] = [ROLES.SUPER_ADMIN, ROLES.QM_ADMIN, ROLES.TECHNICIAN];
export const VENDOR_ROLES: readonly Role[] = [ROLES.VENDOR_ADMIN, ROLES.VENDOR_MANAGER, ROLES.VENDOR_STAFF];
export const ASSIGNABLE_ROLES: readonly StaffRole[] = [
  ROLES.SUPER_ADMIN, ROLES.QM_ADMIN, ROLES.TECHNICIAN,
  ROLES.VENDOR_ADMIN, ROLES.VENDOR_MANAGER, ROLES.VENDOR_STAFF,
];

/** Role groups used by the 3.1 action registry (06_RBAC.gs). */
export const ANY_STAFF: readonly Role[] = ASSIGNABLE_ROLES;
export const ADMIN_ONLY: readonly Role[] = [ROLES.SUPER_ADMIN, ROLES.QM_ADMIN];
export const VENDOR_MGMT: readonly Role[] = [ROLES.SUPER_ADMIN, ROLES.QM_ADMIN, ROLES.VENDOR_ADMIN, ROLES.VENDOR_MANAGER];
export const VENDOR_ANY: readonly Role[] = [ROLES.SUPER_ADMIN, ROLES.QM_ADMIN, ROLES.VENDOR_ADMIN,
  ROLES.VENDOR_MANAGER, ROLES.VENDOR_STAFF];
export const TECH_ANY: readonly Role[] = [ROLES.TECHNICIAN, ROLES.QM_ADMIN, ROLES.SUPER_ADMIN];
export const STAFF_MANAGER_ROLES: readonly Role[] = [ROLES.SUPER_ADMIN, ROLES.QM_ADMIN,
  ROLES.VENDOR_ADMIN, ROLES.VENDOR_MANAGER];

/** WHO MAY GRANT WHAT (00_Config.gs ROLE_GRANTS). */
export const ROLE_GRANTS: Record<Role, readonly StaffRole[]> = {
  SUPER_ADMIN: [ROLES.SUPER_ADMIN, ROLES.QM_ADMIN, ROLES.TECHNICIAN,
    ROLES.VENDOR_ADMIN, ROLES.VENDOR_MANAGER, ROLES.VENDOR_STAFF],
  QM_ADMIN: [ROLES.QM_ADMIN, ROLES.TECHNICIAN, ROLES.VENDOR_ADMIN, ROLES.VENDOR_MANAGER, ROLES.VENDOR_STAFF],
  VENDOR_ADMIN: [ROLES.VENDOR_MANAGER, ROLES.VENDOR_STAFF],
  VENDOR_MANAGER: [ROLES.VENDOR_STAFF],
  VENDOR_STAFF: [],
  TECHNICIAN: [],
  CUSTOMER: [],
};

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Platform owner',
  QM_ADMIN: 'Qatar Mobile admin',
  TECHNICIAN: 'Technician',
  VENDOR_ADMIN: 'Vendor admin',
  VENDOR_MANAGER: 'Vendor manager',
  VENDOR_STAFF: 'Vendor staff',
  CUSTOMER: 'Customer',
};

export const ROLE_HOME: Record<Role, string> = {
  SUPER_ADMIN: 'admin', QM_ADMIN: 'admin', TECHNICIAN: 'technician',
  VENDOR_ADMIN: 'vendor', VENDOR_MANAGER: 'vendor', VENDOR_STAFF: 'vendor', CUSTOMER: 'customer',
};

export const USER_STATUS = {
  PENDING: 'PENDING_APPROVAL', ACTIVE: 'ACTIVE', DISABLED: 'DISABLED', REJECTED: 'REJECTED',
} as const;
export const ENTITY_STATUS = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;

/* -------------------------------------------------------------- trade-in */

export const STATUS = {
  DRAFT: 'DRAFT',
  PENDING_TECHNICIAN: 'PENDING_TECHNICIAN',
  INSPECTION_IN_PROGRESS: 'INSPECTION_IN_PROGRESS',
  INSPECTION_COMPLETED: 'INSPECTION_COMPLETED',
  FINAL_OFFER_READY: 'FINAL_OFFER_READY',
  CUSTOMER_ACCEPTED: 'CUSTOMER_ACCEPTED',
  CUSTOMER_DECLINED: 'CUSTOMER_DECLINED',
  DEVICE_RECEIVED: 'DEVICE_RECEIVED',
  AWAITING_VOUCHER: 'AWAITING_VOUCHER',
  VOUCHER_ISSUED: 'VOUCHER_ISSUED',
  READY_FOR_COLLECTION: 'READY_FOR_COLLECTION',
  COLLECTED: 'COLLECTED',
  SETTLED: 'SETTLED',
  CLOSED: 'CLOSED',
  RETURN_PENDING: 'RETURN_PENDING',
  DEVICE_RETURNED: 'DEVICE_RETURNED',
  CANCELLED: 'CANCELLED',
} as const;
export type TradeInStatus = (typeof STATUS)[keyof typeof STATUS];

/** Legal transitions (TRADEIN_FLOW). Mirrored by public.trade_in_transitions. */
export const TRADEIN_FLOW: Record<TradeInStatus, readonly TradeInStatus[]> = {
  DRAFT: ['PENDING_TECHNICIAN', 'CANCELLED'],
  PENDING_TECHNICIAN: ['INSPECTION_IN_PROGRESS', 'CANCELLED'],
  INSPECTION_IN_PROGRESS: ['INSPECTION_COMPLETED', 'CANCELLED'],
  INSPECTION_COMPLETED: ['FINAL_OFFER_READY', 'INSPECTION_IN_PROGRESS', 'CANCELLED'],
  FINAL_OFFER_READY: ['CUSTOMER_ACCEPTED', 'CUSTOMER_DECLINED', 'INSPECTION_IN_PROGRESS'],
  CUSTOMER_ACCEPTED: ['DEVICE_RECEIVED', 'CANCELLED'],
  CUSTOMER_DECLINED: ['CLOSED'],
  DEVICE_RECEIVED: ['AWAITING_VOUCHER', 'VOUCHER_ISSUED', 'RETURN_PENDING'],
  AWAITING_VOUCHER: ['VOUCHER_ISSUED', 'RETURN_PENDING'],
  VOUCHER_ISSUED: ['READY_FOR_COLLECTION', 'AWAITING_VOUCHER'],
  READY_FOR_COLLECTION: ['COLLECTED', 'AWAITING_VOUCHER'],
  COLLECTED: ['SETTLED'],
  SETTLED: ['CLOSED'],
  RETURN_PENDING: ['DEVICE_RETURNED'],
  DEVICE_RETURNED: ['CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export const CUSTOMER_STATUS_TEXT: Record<TradeInStatus, { label: string; detail: string }> = {
  DRAFT: { label: 'Not submitted', detail: 'This request was never completed.' },
  PENDING_TECHNICIAN: { label: 'Waiting for inspection', detail: 'Bring your device to the shop. Our technician will check it.' },
  INSPECTION_IN_PROGRESS: { label: 'Your device is being inspected', detail: 'A technician is checking your device now.' },
  INSPECTION_COMPLETED: { label: 'Inspection finished', detail: 'We are preparing your final offer.' },
  FINAL_OFFER_READY: { label: 'Your final offer is ready', detail: 'Review it and accept or decline.' },
  CUSTOMER_ACCEPTED: { label: 'Offer accepted', detail: 'Hand your device over at the shop to receive your voucher.' },
  CUSTOMER_DECLINED: { label: 'Offer declined', detail: 'Your device stays with you.' },
  DEVICE_RECEIVED: { label: 'Device received', detail: 'We have your device. Your voucher is being prepared.' },
  AWAITING_VOUCHER: { label: 'Preparing your trade-in voucher', detail: 'Your voucher is being written at the shop.' },
  VOUCHER_ISSUED: { label: 'Trade-in approved', detail: 'Your voucher has been issued.' },
  READY_FOR_COLLECTION: { label: 'Trade-in approved', detail: 'Your voucher has been issued and your trade-in is complete.' },
  COLLECTED: { label: 'Completed', detail: 'Everything is done.' },
  SETTLED: { label: 'Completed', detail: 'Everything is done.' },
  CLOSED: { label: 'Completed', detail: 'Everything is done.' },
  RETURN_PENDING: { label: 'Device being returned', detail: 'Collect your device from the shop.' },
  DEVICE_RETURNED: { label: 'Device returned', detail: 'You have your device back.' },
  CANCELLED: { label: 'Cancelled', detail: 'This trade-in was cancelled.' },
};

export const CUSTOMER_TIMELINE = [
  { key: 'submitted', label: 'Request submitted' },
  { key: 'estimate', label: 'Estimated value received' },
  { key: 'inspection', label: 'Device inspection' },
  { key: 'offer', label: 'Final offer' },
  { key: 'accepted', label: 'Offer accepted' },
  { key: 'received', label: 'Device handed over' },
  { key: 'voucher', label: 'Voucher issued' },
  { key: 'completed', label: 'Completed' },
] as const;

export const CUSTOMER_TIMELINE_STEP: Record<TradeInStatus, number> = {
  DRAFT: 0, PENDING_TECHNICIAN: 2, INSPECTION_IN_PROGRESS: 2, INSPECTION_COMPLETED: 3,
  FINAL_OFFER_READY: 3, CUSTOMER_ACCEPTED: 5, DEVICE_RECEIVED: 6, AWAITING_VOUCHER: 6,
  VOUCHER_ISSUED: 7, READY_FOR_COLLECTION: 7, COLLECTED: 8, SETTLED: 8, CLOSED: 8,
  CUSTOMER_DECLINED: -1, RETURN_PENDING: -1, DEVICE_RETURNED: -1, CANCELLED: -1,
};

export const CUSTODY_STATUSES: readonly TradeInStatus[] = [
  'DEVICE_RECEIVED', 'AWAITING_VOUCHER', 'VOUCHER_ISSUED', 'READY_FOR_COLLECTION',
  'COLLECTED', 'SETTLED', 'CLOSED', 'RETURN_PENDING',
];

export const BILLABLE_STATUSES: readonly TradeInStatus[] = [
  'CUSTOMER_ACCEPTED', 'DEVICE_RECEIVED', 'AWAITING_VOUCHER', 'VOUCHER_ISSUED',
  'READY_FOR_COLLECTION', 'COLLECTED', 'SETTLED', 'CLOSED',
];

/** Statuses after which a device no longer blocks another trade-in of the same IMEI. */
export const IMEI_FREE_STATUSES: readonly TradeInStatus[] = ['CANCELLED', 'CLOSED', 'CUSTOMER_DECLINED'];

/** Money may still be corrected (14_TradeIns.gs CORRECTABLE_STATUSES). */
export const CORRECTABLE_STATUSES: readonly TradeInStatus[] = [
  'INSPECTION_COMPLETED', 'FINAL_OFFER_READY', 'CUSTOMER_ACCEPTED', 'DEVICE_RECEIVED', 'AWAITING_VOUCHER',
];

export const SETTLEABLE_STATUSES: readonly TradeInStatus[] = ['COLLECTED'];

export const VOUCHER_STATUS = { ISSUED: 'ISSUED', VOIDED: 'VOIDED' } as const;

export const COLLECTION_STATUS = {
  DRAFT: 'DRAFT',
  READY_FOR_COLLECTION: 'READY_FOR_COLLECTION',
  PARTIALLY_COLLECTED: 'PARTIALLY_COLLECTED',
  COLLECTED: 'COLLECTED',
  COLLECTION_EXCEPTION: 'COLLECTION_EXCEPTION',
  CANCELLED: 'CANCELLED',
  CLOSED: 'CLOSED',
} as const;
export const COLLECTION_OPEN_STATUSES = ['DRAFT', 'READY_FOR_COLLECTION', 'PARTIALLY_COLLECTED', 'COLLECTION_EXCEPTION'];

export const COLLECTION_ITEM_STATUS = {
  PENDING: 'PENDING', COLLECTED: 'COLLECTED', MISSING: 'MISSING', REJECTED: 'REJECTED', EXCEPTION: 'EXCEPTION',
} as const;
export type CollectionItemStatus = (typeof COLLECTION_ITEM_STATUS)[keyof typeof COLLECTION_ITEM_STATUS];

export const SETTLEMENT_STATUS = {
  DRAFT: 'DRAFT', SUBMITTED: 'SUBMITTED', APPROVED: 'APPROVED', PAID: 'PAID', CLOSED: 'CLOSED', CANCELLED: 'CANCELLED',
} as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUS)[keyof typeof SETTLEMENT_STATUS];

export const SETTLEMENT_STATUS_LABEL: Record<SettlementStatus, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Pending approval', APPROVED: 'Approved', PAID: 'Paid', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};
export const SETTLEMENT_FLOW: Record<SettlementStatus, readonly SettlementStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT'],
  APPROVED: ['PAID'],
  PAID: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};
export const SETTLEMENT_LOCKED: readonly SettlementStatus[] = ['APPROVED', 'PAID', 'CLOSED'];
export const SETTLEMENT_IMMUTABLE: readonly SettlementStatus[] = ['PAID', 'CLOSED'];

export const COMMISSION_TYPE = { PERCENTAGE: 'PERCENTAGE', FIXED: 'FIXED' } as const;
export const PRICE_SOURCE = { VENDOR: 'VENDOR_OVERRIDE', MASTER: 'MASTER', NONE: 'NONE' } as const;

/* ------------------------------------------------------------- grading */

export const INPUT_TYPE = { SWITCH: 'SWITCH', PERCENTAGE: 'PERCENTAGE', LOCK: 'LOCK' } as const;

export const INSPECTION_GROUPS = ['Identity', 'Display', 'Body', 'Functions', 'Battery'] as const;

export const BATTERY_BANDS = [
  { minHealth: 90, fraction: 0.0, label: 'As new' },
  { minHealth: 85, fraction: 0.25, label: 'Good' },
  { minHealth: 80, fraction: 0.5, label: 'Fair' },
  { minHealth: 70, fraction: 0.75, label: 'Worn' },
  { minHealth: 0, fraction: 1.0, label: 'Needs replacing' },
] as const;

export const INSPECTION_BLOCKS: Record<string, string> = {
  ACTIVATION_LOCK: 'The activation lock is still on, so the device cannot be resold.',
  IMEI_MISMATCH: 'The IMEI does not match the device the customer registered.',
};

export const CUSTOMER_BATTERY_PROXY = { GOOD: 95, AVERAGE: 82, POOR: 65 } as const;

export const ASSUMED_GOOD_CODES = ['BACK_GLASS', 'SPEAKER_WORKS', 'MIC_WORKS', 'BUTTONS_WORK', 'WIFI_WORKS', 'BLUETOOTH_WORKS'];

export interface QuestionOption {
  value: string;
  label: string;
  sub?: string;
  note?: string;
  rules?: Record<string, boolean>;
  battery?: number;
}
export interface CustomerQuestion {
  key: string;
  group: string;
  question: string;
  help?: string;
  options: QuestionOption[];
}

export const CUSTOMER_QUESTIONS: CustomerQuestion[] = [
  {
    key: 'POWER', group: 'Device', question: 'Does the device turn on?',
    help: 'Press and hold the power button. If it will not start even on a charger, choose the second option.',
    options: [
      { value: 'ON', label: 'Turns on', rules: { DEVICE_POWERS_ON: true } },
      { value: 'OFF', label: 'Does not turn on', rules: { DEVICE_POWERS_ON: false },
        note: 'A device that will not start is still worth something, but a lot less.' },
    ],
  },
  {
    key: 'SCREEN', group: 'Screen', question: 'How is the screen?',
    help: 'Look at it switched off as well as on — hairline cracks hide against a bright display.',
    options: [
      { value: 'PERFECT', label: 'Perfect', sub: 'No marks at all',
        rules: { SCREEN_WORKS: true, SCREEN_CRACK: true, SCREEN_SCRATCH: true } },
      { value: 'SCRATCHED', label: 'Minor scratches', sub: 'Visible marks, glass intact',
        rules: { SCREEN_WORKS: true, SCREEN_CRACK: true, SCREEN_SCRATCH: false } },
      { value: 'CRACKED', label: 'Cracked', sub: 'The glass is broken',
        rules: { SCREEN_WORKS: true, SCREEN_CRACK: false, SCREEN_SCRATCH: false } },
      { value: 'DEAD', label: 'Not working', sub: 'Black, flickering, or dead spots',
        rules: { SCREEN_WORKS: false, SCREEN_CRACK: false, SCREEN_SCRATCH: false } },
    ],
  },
  {
    key: 'BODY', group: 'Body', question: 'How is the body and frame?', help: 'The sides, the back and the corners.',
    options: [
      { value: 'EXCELLENT', label: 'Excellent', sub: 'Looks almost new',
        rules: { BODY_INTACT: true, BODY_SCRATCH: true, BODY_DENT: true } },
      { value: 'SCRATCHED', label: 'Minor scratches', sub: 'Light wear from normal use',
        rules: { BODY_INTACT: true, BODY_SCRATCH: false, BODY_DENT: true } },
      { value: 'DENTED', label: 'Heavy scratches or dents', sub: 'Clear damage to the frame',
        rules: { BODY_INTACT: true, BODY_SCRATCH: false, BODY_DENT: false } },
      { value: 'DAMAGED', label: 'Damaged', sub: 'Bent, split, or badly broken',
        rules: { BODY_INTACT: false, BODY_SCRATCH: false, BODY_DENT: false } },
    ],
  },
  {
    key: 'CAMERA', group: 'Camera', question: 'Do the cameras work?',
    help: 'Try the front and the back camera, and check the lens glass is not cracked.',
    options: [
      { value: 'OK', label: 'Working', rules: { CAMERA_WORKS: true } },
      { value: 'ISSUE', label: 'Has an issue', rules: { CAMERA_WORKS: false } },
    ],
  },
  {
    key: 'CHARGING', group: 'Charging', question: 'Does it charge normally?', help: 'Plug it in with a cable you know is good.',
    options: [
      { value: 'OK', label: 'Working', rules: { CHARGING_WORKS: true } },
      { value: 'ISSUE', label: 'Has an issue', rules: { CHARGING_WORKS: false } },
    ],
  },
  {
    key: 'BIOMETRIC', group: 'Face ID / Touch ID', question: 'Does Face ID or the fingerprint reader work?',
    help: 'If your device has neither, choose the last option.',
    options: [
      { value: 'OK', label: 'Working', rules: { BIOMETRIC_WORKS: true } },
      { value: 'NO', label: 'Not working', rules: { BIOMETRIC_WORKS: false } },
      { value: 'NA', label: 'Not applicable', sub: 'My device does not have it', rules: { BIOMETRIC_WORKS: true } },
    ],
  },
  {
    key: 'BATTERY', group: 'Battery', question: 'How is the battery?', help: 'On an iPhone: Settings > Battery > Battery Health.',
    options: [
      { value: 'GOOD', label: 'Good', sub: 'Lasts a full day', battery: CUSTOMER_BATTERY_PROXY.GOOD },
      { value: 'AVERAGE', label: 'Average', sub: 'Needs a top-up during the day', battery: CUSTOMER_BATTERY_PROXY.AVERAGE },
      { value: 'POOR', label: 'Poor', sub: 'Drains quickly or needs replacing', battery: CUSTOMER_BATTERY_PROXY.POOR },
    ],
  },
  {
    key: 'ACTIVATION_LOCK', group: 'Activation lock', question: 'Can you remove Find My / the activation lock?',
    help: "We cannot resell a device that is still signed in to somebody else's account. " +
          'You can remove it at the shop — you only need to be able to.',
    options: [
      { value: 'YES', label: 'Yes, I can remove it', rules: { ACTIVATION_LOCK: true } },
      { value: 'NO', label: 'No, I cannot', sub: 'We are not able to accept the device', rules: { ACTIVATION_LOCK: false } },
    ],
  },
];

export const PHOTO_CATEGORIES = [
  { key: 'FRONT', label: 'Front', required: true },
  { key: 'BACK', label: 'Back', required: true },
  { key: 'SCREEN', label: 'Screen on', required: true },
  { key: 'IMEI', label: 'IMEI label', required: true },
  { key: 'DAMAGE', label: 'Damage', required: false },
  { key: 'ACCESSORIES', label: 'Accessories', required: false },
  { key: 'OTHER', label: 'Other', required: false },
] as const;

export const DEVICE_TYPES = [
  { value: 'SMARTPHONE', label: 'Smartphone' },
  { value: 'TABLET', label: 'Tablet' },
  { value: 'WATCH', label: 'Smartwatch' },
  { value: 'LAPTOP', label: 'Laptop' },
  { value: 'AUDIO', label: 'Earbuds or headphones' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const EDITABLE_SETTINGS = [
  { key: 'platform.contactPhone', type: 'STRING', section: 'GENERAL', label: 'Support phone number' },
  { key: 'platform.contactEmail', type: 'STRING', section: 'GENERAL', label: 'Support email' },
  { key: 'customer.termsUrl', type: 'STRING', section: 'GENERAL', label: 'Terms and conditions link' },
  { key: 'customer.estimateNote', type: 'STRING', section: 'CUSTOMER', label: 'Wording shown under an estimate' },
  { key: 'tradein.trackWindowDays', type: 'NUMBER', section: 'OPERATIONS', label: 'Days a trade-in stays visible to the customer' },
  { key: 'collections.reminderDays', type: 'NUMBER', section: 'OPERATIONS', label: 'Warn when devices wait this many days for collection' },
] as const;

export const DEFAULT_ESTIMATE_NOTE =
  'The estimated value is based on the information you provided. The final ' +
  'trade-in value will be confirmed after physical inspection of your device.';

/* ---------------------------------------------------------------- media */

export const MEDIA = {
  MAX_IMAGE_BYTES: 2 * 1024 * 1024,
  MAX_PHOTO_BYTES: 4 * 1024 * 1024,
  PUBLIC_BUCKET: 'catalog-media',
  PRIVATE_BUCKET: 'inspection-photos',
} as const;

/* ---------------------------------------------------------------- audit */

export const ACTIONS = {
  OTP_SENT: 'OTP_SENT', OTP_RATE_LIMITED: 'OTP_RATE_LIMITED', OTP_SEND_FAILED: 'OTP_SEND_FAILED',
  SMS_UNAVAILABLE: 'SMS_UNAVAILABLE_FAIL_CLOSED',
  LOGIN: 'LOGIN', LOGOUT: 'LOGOUT', SESSION_REJECTED: 'SESSION_REJECTED',
  OTP_FAILED: 'OTP_FAILED', OTP_LOCKED_OUT: 'OTP_LOCKED_OUT',
  STAFF_LOGIN_FAILED: 'STAFF_LOGIN_FAILED', STAFF_LOGIN_PAUSED: 'STAFF_LOGIN_PAUSED',
  STAFF_RESET_SENT: 'STAFF_PASSWORD_RESET_SENT', STAFF_RESET_CODE_FAILED: 'STAFF_PASSWORD_RESET_CODE_FAILED',
  STAFF_PASSWORD_SET: 'STAFF_PASSWORD_SET', STAFF_SIGNIN_PROVISIONED: 'STAFF_SIGNIN_PROVISIONED',
  STAFF_SIGNIN_CONFLICT: 'STAFF_SIGNIN_CONFLICT',
  CUSTOMER_REGISTERED: 'CUSTOMER_REGISTERED', EMPLOYEE_REQUESTED: 'EMPLOYEE_ACCESS_REQUESTED',
  PROFILE_LINKED: 'AUTH_PROFILE_LINKED',
  STAFF_APPROVED: 'STAFF_APPROVED', STAFF_REJECTED: 'STAFF_REJECTED', ROLE_CHANGED: 'ROLE_CHANGED',
  VENDOR_ASSIGNED: 'VENDOR_ASSIGNED', BRANCH_ASSIGNED: 'BRANCH_ASSIGNED',
  STAFF_ENABLED: 'STAFF_ENABLED', STAFF_DISABLED: 'STAFF_DISABLED', ACCESS_DENIED: 'ACCESS_DENIED',
  VENDOR_CREATED: 'VENDOR_CREATED', VENDOR_UPDATED: 'VENDOR_UPDATED',
  BRANCH_CREATED: 'BRANCH_CREATED', BRANCH_UPDATED: 'BRANCH_UPDATED',
  BRAND_CREATED: 'BRAND_CREATED', BRAND_UPDATED: 'BRAND_UPDATED',
  CATEGORY_CREATED: 'CATEGORY_CREATED', CATEGORY_UPDATED: 'CATEGORY_UPDATED',
  PRODUCT_CREATED: 'PRODUCT_CREATED', PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  VARIANT_CREATED: 'VARIANT_CREATED', VARIANT_UPDATED: 'VARIANT_UPDATED',
  COLOR_CREATED: 'COLOR_CREATED', COLOR_UPDATED: 'COLOR_UPDATED',
  MEDIA_UPLOADED: 'MEDIA_UPLOADED', BULK_IMPORT: 'BULK_IMPORT',
  BASE_PRICE_SET: 'BASE_PRICE_SET', VENDOR_PRICE_SET: 'VENDOR_PRICE_SET',
  PRICE_RETIRED: 'PRICE_RETIRED', PRICE_CANCELLED: 'PRICE_CANCELLED',
  GRADE_RULE_CHANGED: 'GRADE_RULE_CHANGED', COMMISSION_RULE_SET: 'COMMISSION_RULE_SET',
  TRADEIN_CREATED: 'TRADEIN_CREATED', INSPECTION_STARTED: 'INSPECTION_STARTED', INSPECTION_SAVED: 'INSPECTION_SAVED',
  PHOTOS_UPLOADED: 'PHOTOS_UPLOADED', GRADE_COMPUTED: 'GRADE_COMPUTED_AUTOMATICALLY', GRADE_BLOCKED: 'DEVICE_BLOCKED_BY_RULE',
  INSPECTION_RULE_SET: 'INSPECTION_RULE_CHANGED', OFFER_SUBMITTED: 'FINAL_OFFER_SUBMITTED',
  MANUAL_OVERRIDE: 'MANUAL_PRICE_OVERRIDE', CUSTOMER_ACCEPTED: 'CUSTOMER_ACCEPTED', CUSTOMER_DECLINED: 'CUSTOMER_DECLINED',
  DEVICE_RECEIVED: 'DEVICE_RECEIVED', DEVICE_RETURN_START: 'DEVICE_RETURN_STARTED', DEVICE_RETURNED: 'DEVICE_RETURNED',
  VOUCHER_ISSUED: 'VOUCHER_ISSUED', VOUCHER_BLOCKED: 'VOUCHER_BLOCKED_NO_DEVICE', VOUCHER_VOIDED: 'VOUCHER_VOIDED',
  VOUCHER_REISSUED: 'VOUCHER_REISSUED',
  COLLECTION_CREATED: 'COLLECTION_BATCH_CREATED', COLLECTION_MARKED: 'COLLECTION_MARKED_COLLECTED',
  COLLECTION_CLOSED: 'COLLECTION_CLOSED', COLLECTION_CANCELLED: 'COLLECTION_BATCH_CANCELLED',
  DEVICE_COLLECTED: 'DEVICE_COLLECTED', DEVICE_NOT_COLLECTED: 'DEVICE_NOT_COLLECTED',
  SETTLEMENT_CREATED: 'SETTLEMENT_CREATED', SETTLEMENT_SUBMITTED: 'SETTLEMENT_SUBMITTED',
  SETTLEMENT_APPROVED: 'SETTLEMENT_APPROVED', SETTLEMENT_PAID: 'SETTLEMENT_PAID', SETTLEMENT_CLOSED: 'SETTLEMENT_CLOSED',
  SETTLEMENT_CANCELLED: 'SETTLEMENT_CANCELLED', SETTLEMENT_REOPENED: 'SETTLEMENT_RETURNED_TO_DRAFT',
  TRADEIN_CLOSED: 'TRADEIN_CLOSED',
  ESTIMATE_GIVEN: 'CUSTOMER_ESTIMATE_GIVEN', QUESTIONNAIRE_SAVED: 'CUSTOMER_QUESTIONNAIRE_SAVED',
  GRADE_OVERRIDDEN: 'GRADE_OVERRIDDEN_BY_ADMIN',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY',
  CUSTOMER_STATUS_CHANGED: 'CUSTOMER_STATUS_CHANGED',
  CUSTOMER_PROFILE_UPDATED: 'CUSTOMER_PROFILE_UPDATED',
  RECONCILIATION_RUN: 'RECONCILIATION_RUN',
} as const;

export const NOTIFY = {
  TRADEIN_NEW: 'TRADEIN_NEW', INSPECTION_DONE: 'INSPECTION_DONE', OFFER_READY: 'OFFER_READY',
  VOUCHER_READY: 'VOUCHER_READY', COLLECTION_READY: 'COLLECTION_READY', COLLECTION_EXCEPTION: 'COLLECTION_EXCEPTION',
  SETTLEMENT_CREATED: 'SETTLEMENT_CREATED', SETTLEMENT_PAID: 'SETTLEMENT_PAID', STAFF_PENDING: 'STAFF_PENDING',
} as const;

/* ---------------------------------------------------------- OTP limits */

/** 3.1 defaults (CFG.OTP); each can be overridden by environment within the same bounds. */
export const OTP_DEFAULTS = {
  LENGTH: 6,
  TTL_MINUTES: 5,
  RESEND_COOLDOWN_S: 60,
  MAX_ATTEMPTS: 5,
  MAX_SENDS_PER_HOUR: 6,
  MAX_SENDS_PER_DAY: 12,
  GLOBAL_MAX_PER_HOUR: 300,
  GLOBAL_MAX_PER_DAY: 2000,
  REGISTER_GLOBAL_MAX_PER_HOUR: 60,
  REGISTER_GLOBAL_MAX_PER_DAY: 300,
} as const;
