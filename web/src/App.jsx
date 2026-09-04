import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Schedule from './pages/Schedule.jsx';
import Calls from './pages/Calls.jsx';
import CallDetail from './pages/CallDetail.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import JobDetail from './pages/JobDetail.jsx';
import Tasks from './pages/Tasks.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="calls" element={<Calls />} />
        <Route path="calls/:id" element={<CallDetail />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="jobs/:id" element={<JobDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="*" element={<div className="py-20 text-center text-slate-500">Page not found.</div>} />
      </Route>
    </Routes>
  );
}
