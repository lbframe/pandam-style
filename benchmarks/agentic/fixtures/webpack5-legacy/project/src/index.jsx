import { createRoot } from 'react-dom/client';
import './styles/main.scss';
import { InventoryTable } from './components/InventoryTable.jsx';

const container = document.createElement('div');
document.body.appendChild(container);
createRoot(container).render(<InventoryTable />);
