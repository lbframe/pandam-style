import { BookingCard } from './components/BookingCard.jsx';
import { Header } from './components/Header.jsx';

export function App() {
  return (
    <div className="app">
      <Header />
      <BookingCard nights={3} occupancy={0.72} />
    </div>
  );
}
