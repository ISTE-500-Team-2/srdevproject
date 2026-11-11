// Page and workspace styles, loaded up front in the order the static import graph
// produced before page code was split into lazily loaded areas (see src/areas).
// Keeping this order keeps the cascade exactly as it was, ahead of styles.css and
// tables.css. A page that adds a stylesheet should add it here too.
import './components/reactbits/HoldButton.css';
import './pages/certwaiver.css';
import './components/reactbits/StatusMark.css';
import './components/monthCalendar.css';
import './pages/studios.css';
import './components/EquipmentPriceBreakdown.css';
import './pages/admin/equipment.css';
import './assets/css/analyticsDashboard.css';
import './pages/plans.css';
import './components/appearanceControl.css';
import './pages/admin/today.css';
import './components/reactbits/CardNav.css';
import './pages/classes.css';
import './pages/certifications.css';
import './components/reactbits/SpringCheck.css';
import './components/reactbits/Stepper.css';
import './pages/profile.css';
import './pages/membership.css';
import './management.css';
import './admin.css';
import './components/staff/paymentTable.css';
import './pages/payments.css';
