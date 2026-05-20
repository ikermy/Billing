export type Barcode = {
  id: string;
  url: string;
  type: 'PDF417' | 'CODE128';
  data: string;
  userId: string;
  editFlag: boolean;
  createdAt: Date;
  updatedAt: Date;
};
