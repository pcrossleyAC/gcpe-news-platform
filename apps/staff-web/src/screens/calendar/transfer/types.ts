/** apps/calendar/src/transfer.ts's TransferContact. */
export interface TransferContact {
  id: number;
  userId: string;
  displayName: string;
  ministryKey: string;
  ministryAbbreviation: string | null;
  ministryName: string;
  isActive: boolean;
  /** Whether it may be the contact transferred to (apps/calendar/src/transfer.ts's receiveRefusal):
   * false when it's inactive, its ministry is inactive, or its ministry is excluded. Any listed
   * contact may still be transferred from, active or not. */
  canReceive: boolean;
  /** "Name (ABBR)", as legacy's dropdowns (Admin/Transfer.aspx.cs:20-27) and the history. */
  label: string;
}
export interface TransferPreview {
  from: TransferContact;
  to: TransferContact;
  count: number;
}

export const plural = (n: number) => `${n} ${n === 1 ? "activity" : "activities"}`;
