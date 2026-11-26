export type StockOpnameStatus = 'COUNTING' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface StockOpnameItem {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  snapshotQty: string;
  snapshotVersion: string;
  countedQty: string | null;
  countCutoffVersion: string | null;
  countedAt: string | null;
  countedBy: string | null;
  draftVersion: string;
  reservationToken: string | null;
  reservedBy: string | null;
  reservationVersion: string | null;
  reservationExpiresAt: string | null;
}

export interface StockOpnameSession {
  id: string;
  storeId: string;
  status: StockOpnameStatus;
  initiatedBy: string;
  initiatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  items?: StockOpnameItem[];
}

export interface StockOpnameReviewItem extends StockOpnameItem {
  expectedAtCount: string;
  variance: string;
}

export interface StockOpnameReview extends Omit<StockOpnameSession, 'items'> {
  items: StockOpnameReviewItem[];
}

/** Full manager-only view, including inventory reconciliation fields. */
export type ManagerStockOpnameSession = StockOpnameSession;

/** Blind-count view. The reservation token is an opaque, single-use capability. */
export interface StaffStockOpnameItem {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  countedQty: string | null;
  countedAt: string | null;
  reservationToken: string | null;
  reservationStatus: 'AVAILABLE' | 'RESERVED' | 'COUNTED';
}

export interface StaffStockOpnameSession extends Omit<StockOpnameSession, 'items'> {
  items?: StaffStockOpnameItem[];
}
