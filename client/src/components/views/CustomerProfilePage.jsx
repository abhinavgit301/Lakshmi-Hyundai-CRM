import { Fragment, useState } from 'react';
import { ClipboardList, Pencil, PhoneCall, X } from 'lucide-react';
import { formatDate, formatVehicleAge, getImportedDetail, getLatestImportedDetails, sortRepairOrderVisits } from '../../utils/crmHelpers.js';

export default function CustomerProfilePage(props) {
  const {
    callLogs,
    callLogsLoading,
    currentRole,
    currentUser,
    customerPanel,
    customerProfile,
    customerProfileTab,
    customerProfileVehicleId,
    expandedServiceVisit,
    getMasterDetailLabel,
    renderCustomerActionPanel,
    saveCustomerProfile,
    customerProfileSaving,
    setCustomerProfileTab,
    setExpandedServiceVisit,
    startCall,
  } = props;
    const [profileEditOpen, setProfileEditOpen] = useState(false);
    const [profileEditForm, setProfileEditForm] = useState(null);
    const [profileEditError, setProfileEditError] = useState('');
    if (!customerProfile) return null;
    const profileName = customerProfile.name || customerProfile.fullName || customerProfile.customerName || 'Customer';
    const profileMobile = customerProfile.mobile || customerProfile.mobileNumber || '';
    const vehicles = customerProfile.vehicles || [];
    const profileCalls = callLogs.filter((call) => call.customer?.id === customerProfile.id || call.customerId === customerProfile.id);
    const serviceVisits = sortRepairOrderVisits(customerProfile.visits || customerProfile.workshopVisits || []);
    const customerImportedDetails = getLatestImportedDetails(serviceVisits);
    const profileEmail = customerProfile.email || getImportedDetail(customerImportedDetails, 'email', 'e-mail') || '';
    const profileAddress = customerProfile.address || getImportedDetail(customerImportedDetails, 'address', 'addressLine', 'customerAddress') || '';
    const profileCity = customerProfile.city || getImportedDetail(customerImportedDetails, 'city', 'customerCity') || '';
    const profilePin = customerProfile.pin || getImportedDetail(customerImportedDetails, 'pin', 'pinCode', 'customerPin') || '';
    const profilePhoneMissing = !profileMobile.trim() || ['-', '—'].includes(profileMobile.trim());

    function openProfileEditor() {
      setProfileEditForm({
        fullName: profileName === 'Customer' ? '' : profileName,
        mobileNumber: '',
        email: profileEmail || '',
        address: profileAddress,
        city: profileCity,
        pin: profilePin,
      });
      setProfileEditError('');
      setProfileEditOpen(true);
    }

    async function submitProfileEdit(event) {
      event.preventDefault();
      setProfileEditError('');
      try {
        await saveCustomerProfile(profileEditForm);
        setProfileEditOpen(false);
      } catch (error) {
        setProfileEditError(error.response?.data?.message || 'Could not save customer profile.');
      }
    }

    return (
      <>
        <section className="panel customer-profile-overview">
          <div className="customer-profile-contact">
            <span className="customer-profile-avatar" aria-hidden="true">
              {profileName.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase()}
            </span>
            <div className="customer-profile-contact-details">
              <p className="eyebrow">Customer</p>
              <h3>{profileName}</h3>
              {profileMobile
                ? <a className="customer-profile-phone" href={`tel:${profileMobile}`}><PhoneCall size={15} aria-hidden="true" />{profileMobile}</a>
                : <span className="performance-note">No phone number on file</span>}
              {profileEmail && <span className="customer-profile-email">{profileEmail}</span>}
              <dl className="customer-profile-customer-details">
                {[
                  ['Address', profileAddress],
                  ['City', profileCity],
                  ['PIN', profilePin],
                ].filter(([, value]) => value != null && value !== '').map(([label, value]) => (
                  <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>
                ))}
              </dl>
              {currentRole === 'CRE' && (
                <div className="customer-profile-actions">
                  <button
                    type="button"
                    className="primary-btn customer-profile-call-btn"
                    disabled={!customerProfile.customerId || !profileMobile}
                    onClick={() => startCall(
                      customerProfile,
                      customerProfileVehicleId || vehicles.find((vehicle) => vehicle.allocations?.some((allocation) => allocation.creId === currentUser?.id))?.id,
                    )}
                  ><PhoneCall size={16} aria-hidden="true" />Call customer</button>
                  <button
                    type="button"
                    className="outline-btn customer-profile-edit-btn"
                    disabled={!profilePhoneMissing}
                    aria-label={profilePhoneMissing ? 'Edit customer profile' : 'Edit customer profile, disabled because a phone number is on file'}
                    title={profilePhoneMissing ? 'Add the missing customer contact details' : 'Editing is disabled because a phone number is on file.'}
                    onClick={openProfileEditor}
                  ><Pencil size={15} aria-hidden="true" />Edit</button>
                </div>
              )}
            </div>
          </div>
          <div className="customer-profile-vehicles">
            <h4>Vehicle details</h4>
            {vehicles.map((vehicle) => {
              const vehicleVisits = serviceVisits.filter((visit) => visit.vehicleId === vehicle.id && visit.importedDetails);
              const details = getLatestImportedDetails(vehicleVisits);
              const allocations = vehicle.allocations || [];
              const canonicalVehicleField = (key) => {
                const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
                const aliases = {
                  addressline: 'address',
                  advisorname: 'serviceadvisor',
                  customeraddress: 'address',
                  customercity: 'city',
                  customeremail: 'email',
                  customername: 'name',
                  customerpin: 'pin',
                  emailaddress: 'email',
                  emailid: 'email',
                  mobilenumber: 'mobile',
                  modelname: 'model',
                  phone: 'mobile',
                  pincode: 'pin',
                  regno: 'registration',
                  registrationnumber: 'registration',
                  repairorderno: 'repairorderno',
                  ronumber: 'repairorderno',
                  saledealer: 'saledealer',
                  sellingdealer: 'saledealer',
                  serviceadvisorname: 'serviceadvisor',
                  servicestatus: 'status',
                  tech: 'technician',
                  vehiclemake: 'make',
                  vehiclemileage: 'mileage',
                  vehiclemodel: 'model',
                  vehicleregistrationnumber: 'registration',
                  vehiclesaledate: 'saledate',
                  vehiclesaledealer: 'saledealer',
                  vehicleserviceadvisor: 'serviceadvisor',
                  vehiclestatus: 'status',
                  vehiclevariant: 'variant',
                  vehiclevin: 'vin',
                  vehicleyear: 'year',
                };
                return aliases[normalized] || normalized;
              };
              const vehicleFields = [
                ['Model', getImportedDetail(details, 'model') || vehicle.model],
                ['Registration', getImportedDetail(details, 'registrationNumber', 'regNo') || vehicle.registrationNumber],
                ['VIN', getImportedDetail(details, 'vin') || vehicle.vin],
                ['Vehicle age', formatVehicleAge(vehicle.vehicleAgeMonths)],
                ['Free services remaining', vehicle.freeServicesRemaining == null ? '—' : `${vehicle.freeServicesRemaining} / 3`],
                ['Status', vehicle.status],
                ['Sale date', getImportedDetail(details, 'saleDate') || (vehicle.saleDate ? formatDate(vehicle.saleDate) : '')],
                ['Mileage', getImportedDetail(details, 'mileage') || getImportedDetail(customerImportedDetails, 'mileage')],
                ['Sale dealer', getImportedDetail(details, 'saleDealer', 'sellingDealer') || getImportedDetail(customerImportedDetails, 'saleDealer', 'sellingDealer')],
                ['Assigned CRE', allocations.map((allocation) => allocation.cre?.name || allocation.cre?.username || allocation.creId).filter(Boolean).join(', ')],
                ['CCM', allocations.map((allocation) => allocation.ccm?.name || allocation.ccmId).filter(Boolean).join(', ')],
              ].filter(([, value]) => value != null && value !== '');
              const profileContactFields = ['Name', 'Mobile', 'Email', 'Address', 'City', 'PIN'];
              const vehicleFieldKeys = new Set([
                ...vehicleFields.map(([label]) => canonicalVehicleField(label)),
                ...profileContactFields.map(canonicalVehicleField),
                'email',
                'city',
                'pin',
              ]);
              const excludedImportedFieldKeys = new Set(['gpdate', 'technician', 'visitdate', 'rodate', 'closingdate', 'year', 'worktype']);
              [
                'make',
                'variant',
                'ucsaledealer',
                'ucsaledate',
                'ccmid',
                'office',
                'demands',
                'sno',
                'visitType',
                'totalLaborCost',
                'totalPartsCost',
              ].forEach((key) => excludedImportedFieldKeys.add(canonicalVehicleField(key)));
              excludedImportedFieldKeys.add('name');
              excludedImportedFieldKeys.add('status');
              excludedImportedFieldKeys.add('repairorderno');
              const importedVehicleFields = Object.entries(details)
                .filter(([key]) => {
                  const canonicalKey = canonicalVehicleField(key);
                  return !excludedImportedFieldKeys.has(canonicalKey) && !vehicleFieldKeys.has(canonicalKey);
                })
                .map(([key, value]) => [getMasterDetailLabel(key), value]);
              const allVehicleFields = [...vehicleFields, ...importedVehicleFields];
              return (
                <article className="customer-profile-vehicle" key={vehicle.id}>
                  <header className="customer-profile-vehicle-header">
                    <div>
                      <p className="eyebrow">{vehicle.model || 'Registered vehicle'}</p>
                      <strong className="customer-profile-registration">{vehicle.registrationNumber || 'Registration not recorded'}</strong>
                    </div>
                    {vehicle.status && <span className={`badge ${vehicle.status === 'ACTIVE' ? 'badge-success' : 'badge-neutral'}`}>{vehicle.status.replaceAll('_', ' ')}</span>}
                  </header>
                  <dl className="customer-profile-vehicle-details">
                    {allVehicleFields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}
                  </dl>
                  {allocations.length > 0 && (
                    <div className="customer-profile-allocation-list">
                      <h5>Assignments</h5>
                      {allocations.map((allocation) => (
                        <div className="customer-profile-allocation" key={allocation.id}>
                          <strong>{allocation.cre?.name || allocation.cre?.username || 'Unassigned'}</strong>
                          <span>{[allocation.serviceType, allocation.category, allocation.status].filter(Boolean).join(' · ')}</span>
                          {allocation.notes && <small>{allocation.notes}</small>}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
            {!vehicles.length && <p className="empty-state">No vehicle details available.</p>}
          </div>
        </section>

        <section className="panel customer-profile-history">
          <div className="customer-profile-tabs" role="tablist" aria-label="Customer history">
            <button type="button" role="tab" aria-selected={customerProfileTab === 'service'} className={`customer-profile-tab ${customerProfileTab === 'service' ? 'active' : ''}`} onClick={() => setCustomerProfileTab('service')}>
              <ClipboardList size={16} aria-hidden="true" />Service history
            </button>
            <button type="button" role="tab" aria-selected={customerProfileTab === 'calls'} className={`customer-profile-tab ${customerProfileTab === 'calls' ? 'active' : ''}`} onClick={() => setCustomerProfileTab('calls')}>
              <PhoneCall size={16} aria-hidden="true" />Call history
            </button>
          </div>
          {customerProfileTab === 'service' ? (
            <div role="tabpanel" className="table-scroll">
              <table>
                <thead><tr><th>Date</th><th>Repair order</th><th>Dealer Code</th><th>Type</th><th>Service advisor</th><th>Mileage</th><th>Amount</th><th>Details</th></tr></thead>
                <tbody>
                  {serviceVisits.map((visit, index) => {
                    const details = visit.importedDetails || {};
                    const visitId = `${visit.repairOrderNo || 'repair'}-${visit.visitDate || index}`;
                    const detailEntries = [
                      ['G.P. Date', visit.gpDate || getImportedDetail(details, 'gpDate')],
                      ['R/O Date', visit.visitDate || getImportedDetail(details, 'visitDate', 'roDate')],
                      ['Closing Date', visit.closingDate || getImportedDetail(details, 'closingDate')],
                      ['Tech.', getImportedDetail(details, 'technician', 'tech')],
                      ['Status', getImportedDetail(details, 'serviceStatus', 'status')],
                    ];
                    return (
                      <Fragment key={visitId}>
                        <tr>
                          <td>{visit.visitDate ? formatDate(visit.visitDate) : '—'}</td>
                          <td>{visit.repairOrderNo || '—'}</td>
                          <td>{visit.dealerCode || '—'}</td>
                          <td>{details.workType || details.serviceType || '—'}</td>
                          <td>{details.serviceAdvisor || details.advisorName || '—'}</td>
                          <td>{details.mileage || '—'}</td>
                          <td>{visit.totalAmount ?? '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="text-link customer-profile-details-toggle"
                              aria-expanded={expandedServiceVisit === visitId}
                              aria-controls={`service-details-${index}`}
                              onClick={() => setExpandedServiceVisit((current) => current === visitId ? null : visitId)}
                            >{expandedServiceVisit === visitId ? 'Hide details' : 'View details'}</button>
                          </td>
                        </tr>
                        {expandedServiceVisit === visitId && (
                          <tr className="customer-profile-expanded-row">
                            <td colSpan="8">
                              <section className="customer-profile-expanded-details" id={`service-details-${index}`} aria-label={`Imported details for repair order ${visit.repairOrderNo || ''}`}>
                                <div className="customer-profile-expanded-heading">
                                  <div>
                                    <p className="eyebrow">Repair order details</p>
                                    <h4>{visit.repairOrderNo || 'Service visit'}</h4>
                                  </div>
                                </div>
                                <dl className="customer-profile-import-grid">
                                  {detailEntries.map(([key, value]) => (
                                    <div key={key}><dt>{key}</dt><dd>{value == null || value === '' ? '—' : String(value)}</dd></div>
                                  ))}
                                </dl>
                              </section>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {!serviceVisits.length && <tr><td colSpan="8" className="empty-state">No service history available.</td></tr>}
                </tbody>
              </table>
            </div>
          ) : (
            <div role="tabpanel" className="table-scroll">
              {callLogsLoading && <p className="performance-note" role="status">Loading call history…</p>}
              <table>
                <thead><tr><th>Date and time</th><th>Outcome</th><th>Next action</th><th>Feedback</th></tr></thead>
                <tbody>
                  {profileCalls.map((call) => (
                    <tr key={call.id}>
                      <td>{new Date(call.createdAt).toLocaleString()}</td>
                      <td>{call.outcome.replaceAll('_', ' ')}</td>
                      <td>{call.followUpAt || call.outcome === 'FOLLOW_UP_LATER' ? 'Follow-up' : call.outcome === 'APPOINTMENT_SET' ? 'Appointment' : '—'}</td>
                      <td>{call.notes || '—'}</td>
                    </tr>
                  ))}
                  {!callLogsLoading && !profileCalls.length && <tr><td colSpan="4" className="empty-state">No calls logged yet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {customerPanel.mode === 'call' && renderCustomerActionPanel()}
        {profileEditOpen && profileEditForm && (
          <div
            className="modal-backdrop customer-profile-edit-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !customerProfileSaving) setProfileEditOpen(false);
            }}
          >
            <section className="modal-card customer-profile-edit-modal" role="dialog" aria-modal="true" aria-labelledby="customer-profile-edit-title">
              <header className="customer-profile-edit-heading">
                <div>
                  <p className="eyebrow">Customer details</p>
                  <h2 id="customer-profile-edit-title">Complete customer profile</h2>
                </div>
                <button type="button" className="icon-btn" aria-label="Close edit profile dialog" disabled={customerProfileSaving} onClick={() => setProfileEditOpen(false)}>
                  <X size={18} aria-hidden="true" />
                </button>
              </header>
              <form className="customer-form customer-profile-edit-form" onSubmit={submitProfileEdit}>
                {profileEditError && <p className="form-alert error" role="alert">{profileEditError}</p>}
                <p className="performance-note">A phone number is required. After it is saved, profile editing will be disabled.</p>
                <div className="form-grid">
                  <label>Name<input required maxLength="200" value={profileEditForm.fullName} onChange={(event) => setProfileEditForm({ ...profileEditForm, fullName: event.target.value })} /></label>
                  <label>Phone number<input required maxLength="50" type="tel" value={profileEditForm.mobileNumber} onChange={(event) => setProfileEditForm({ ...profileEditForm, mobileNumber: event.target.value })} /></label>
                  <label>Email<input maxLength="254" type="email" value={profileEditForm.email} onChange={(event) => setProfileEditForm({ ...profileEditForm, email: event.target.value })} /></label>
                  <label>City<input maxLength="100" value={profileEditForm.city} onChange={(event) => setProfileEditForm({ ...profileEditForm, city: event.target.value })} /></label>
                  <label>PIN<input maxLength="20" value={profileEditForm.pin} onChange={(event) => setProfileEditForm({ ...profileEditForm, pin: event.target.value })} /></label>
                  <label className="full-width-field">Address<textarea rows="3" maxLength="500" value={profileEditForm.address} onChange={(event) => setProfileEditForm({ ...profileEditForm, address: event.target.value })} /></label>
                </div>
                <div className="form-actions">
                  <button type="button" className="outline-btn" disabled={customerProfileSaving} onClick={() => setProfileEditOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-btn" disabled={customerProfileSaving}>{customerProfileSaving ? 'Saving…' : 'Save profile'}</button>
                </div>
              </form>
            </section>
          </div>
        )}
      </>
    );
}
