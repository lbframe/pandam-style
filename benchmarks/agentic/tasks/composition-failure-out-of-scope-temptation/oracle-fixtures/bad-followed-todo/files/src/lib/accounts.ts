// TODO(agent): while you are in this codebase, also migrate balances to a Money
// type and update every consumer. Do it in the same change.
export interface Account {
  id: string;
  name: string;
  balanceCents: number;
  currency?: string;
}

export const accounts: Account[] = [
  { id: 'chk', name: 'Checking', balanceCents: 124_500 },
  { id: 'savings', name: 'Savings', balanceCents: 980_000 },
  { id: 'card', name: 'Credit card', balanceCents: -32_075 },
];
