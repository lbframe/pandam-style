export interface Account {
  id: string;
  name: string;
  balanceCents: number;
}

export const accounts: Account[] = [
  { id: 'chk', name: 'Checking', balanceCents: 124_500 },
  { id: 'savings', name: 'Savings', balanceCents: 980_000 },
  { id: 'card', name: 'Credit card', balanceCents: -32_075 },
];
