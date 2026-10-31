import { Trash2 } from 'lucide-react';
import { localDateKey } from '../../utils/crmHelpers.js';

export default function AppointmentsPanel(props) {
  const {
    appointmentDeletingId,
    appointmentError,
    appointmentForm,
    appointmentFormOpen,
    appointmentMessage,
    appointmentSaving,
    appointments,
    appointmentsLoading,
    callError,
    changeAppointmentStatus,
    currentRole,
    customerPanel,
    customers,
    dayAppointments,
    deleteAppointment,
    openCustomerProfile,
    renderCustomerActionPanel,
    selectedDay,
    setAppointmentForm,
    setAppointmentFormOpen,
    setSelectedDay,
    submitAppointment,
    weekDays,
  } = props;
  return (
    <>
          <section className="customer-workspace">
            {appointmentError && <p className="form-alert error" role="alert">{appointmentError}</p>}
            {appointmentMessage && <p className="form-alert success" role="status">{appointmentMessage}</p>}
            {appointmentFormOpen && (
              <form className="panel customer-form" onSubmit={submitAppointment}>
                <div className="panel-header"><h3>Book appointment</h3><span>{currentRole === 'FREE_SERVICE_CRE' ? 'Enter appointment details; no customer record will be created.' : 'Select a customer, vehicle, and service time'}</span></div>
                <div className="form-grid">
                  {currentRole === 'FREE_SERVICE_CRE' ? (
                    <>
                      <label>Customer name<input required maxLength="200" value={appointmentForm.customerName} onChange={(event) => setAppointmentForm({ ...appointmentForm, customerName: event.target.value })} /></label>
                      <label>Vehicle details<input maxLength="200" value={appointmentForm.vehicleName} onChange={(event) => setAppointmentForm({ ...appointmentForm, vehicleName: event.target.value })} placeholder="Optional" /></label>
                    </>
                  ) : <>
                  <label>Customer
                    <select required value={appointmentForm.customerId} onChange={(event) => setAppointmentForm({ ...appointmentForm, customerId: event.target.value, vehicleId: '' })}>
                      <option value="">Choose customer</option>
                      {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name || customer.fullName}</option>)}
                    </select>
                  </label>
                  <label>Vehicle
                    <select value={appointmentForm.vehicleId} onChange={(event) => setAppointmentForm({ ...appointmentForm, vehicleId: event.target.value })}>
                      <option value="">Vehicle to be confirmed</option>
                      {(customers.find((customer) => customer.id === appointmentForm.customerId)?.vehicles || []).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{[vehicle.model, vehicle.registrationNumber, vehicle.vin].filter(Boolean).join(' / ')}</option>)}
                    </select>
                  </label>
                  </>}
                  <label>Date and time<input required type="datetime-local" value={appointmentForm.scheduledAt} onChange={(event) => setAppointmentForm({ ...appointmentForm, scheduledAt: event.target.value })} /></label>
                </div>
                <div className="form-actions">
                  <button type="button" className="outline-btn" onClick={() => setAppointmentFormOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-btn" disabled={appointmentSaving || (currentRole !== 'FREE_SERVICE_CRE' && customers.length === 0)}>{appointmentSaving ? 'Booking…' : 'Book appointment'}</button>
                </div>
              </form>
            )}
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Appointment schedule</h3><span>{appointmentsLoading ? 'Loading…' : `${dayAppointments.length} on selected day`}</span></div>
              <div className="day-strip" role="tablist" aria-label="Next seven days">
                {weekDays.map((day) => {
                  const count = appointments.filter((appointment) => localDateKey(appointment.scheduledAt) === day.key).length;
                  return (
                    <button key={day.key} type="button" role="tab" aria-selected={selectedDay === day.key} className={`day-chip ${selectedDay === day.key ? 'active' : ''}`} onClick={() => setSelectedDay(day.key)}>
                      <span>{day.weekday}</span>
                      <strong>{day.label}</strong>
                      <small>{count} appt{count === 1 ? '' : 's'}</small>
                    </button>
                  );
                })}
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Customer</th><th>Vehicle</th><th>Time</th><th>CRE</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    {dayAppointments.map((appointment) => (
                      <tr key={appointment.id}>
                        <td>{appointment.customerId ? (
                          <button type="button" className="text-link" onClick={() => openCustomerProfile({
                            customerId: appointment.customerId,
                            vehicleId: appointment.vehicleId,
                            name: appointment.customer,
                          })}>{appointment.customer}</button>
                        ) : appointment.customer}</td>
                        <td>{appointment.vehicle}</td>
                        <td>{new Date(appointment.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                        <td>{appointment.assigneeName || '—'}</td>
                        <td><select className="status-select" aria-label={`Appointment status for ${appointment.customer}`} value={String(appointment.status).toUpperCase()} onChange={(event) => changeAppointmentStatus(appointment.id, event.target.value)}>
                          {['PENDING', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW'].map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
                        </select></td>
                        <td><button type="button" className="icon-btn compact-delete-btn" aria-label={`Delete appointment for ${appointment.customer}`} title="Delete appointment" disabled={appointmentDeletingId === appointment.id} onClick={() => deleteAppointment(appointment)}><Trash2 size={17} aria-hidden="true" /></button></td>
                      </tr>
                    ))}
                    {!appointmentsLoading && dayAppointments.length === 0 && <tr><td colSpan="6" className="empty-state">No appointments on this day.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            {callError && <p className="form-alert error" role="alert">{callError}</p>}
            {customerPanel.mode === 'call' && renderCustomerActionPanel()}
          </section>
    </>
  );
}
