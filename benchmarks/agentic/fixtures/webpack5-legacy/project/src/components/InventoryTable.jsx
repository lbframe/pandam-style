const rows = [
  { sku: 'A-100', name: 'Bolts', stock: 1200 },
  { sku: 'B-220', name: 'Hinges', stock: 4 },
];

export function InventoryTable() {
  return (
    <table className="inventory">
      <tbody>
        {rows.map((row) => (
          <tr key={row.sku} className={row.stock < 10 ? 'inventory__row--low' : undefined}>
            <td>{row.sku}</td>
            <td>{row.name}</td>
            <td>{row.stock}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
