import { Save, X } from 'lucide-react';

export default function UserManagementPanel(props) {
  const {
    closeUserForm,
    currentRole,
    currentUser,
    deleteManagedAccount,
    editingUserId,
    managedTeams,
    managedUsers,
    managedUsersError,
    managedUsersLoading,
    managedUsersMessage,
    openCcmProfile,
    passwordUnlocked,
    setPasswordUnlocked,
    setUserForm,
    startUserEdit,
    submitManagedUser,
    toggleManagedUserStatus,
    userForm,
    userFormCloseButtonRef,
    userFormClosing,
    userFormDialogRef,
    userFormOpen,
    userSaving,
    userTree,
  } = props;
  return (
          <section className="customer-workspace">
            {!userFormOpen && managedUsersError && <p className="form-alert error" role="alert">{managedUsersError}</p>}
            {managedUsersMessage && <p className="form-alert success" role="status">{managedUsersMessage}</p>}
            {userFormOpen && (
              <div
                className={`user-modal-backdrop${userFormClosing ? ' is-closing' : ''}`}
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget && !userSaving) closeUserForm();
                }}
              >
                <section
                  className="user-modal-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="user-form-dialog-title"
                  aria-describedby="user-form-dialog-description"
                  tabIndex={-1}
                  ref={userFormDialogRef}
                >
                  <form className="user-modal-form" onSubmit={submitManagedUser}>
                    <header className="user-modal-header">
                      <div>
                        <h3 id="user-form-dialog-title">{editingUserId ? 'Edit User' : 'Create New Account'}</h3>
                        <p id="user-form-dialog-description">Admin, GM, CCM, CRE, and Free-Service CRE accounts</p>
                      </div>
                      <button
                        ref={userFormCloseButtonRef}
                        type="button"
                        className="user-modal-close"
                        aria-label="Close user form"
                        title="Close"
                        disabled={userSaving}
                        onClick={() => closeUserForm()}
                      >
                        <X size={19} aria-hidden="true" />
                      </button>
                    </header>
                    {managedUsersError && <p className="form-alert error user-modal-error" role="alert">{managedUsersError}</p>}
                    <fieldset className="user-modal-fields" disabled={userSaving}>
                      <div className="form-grid">
                  <label>Full name<input required maxLength="200" value={userForm.name} onChange={(event) => setUserForm({ ...userForm, name: event.target.value })} /></label>
                  <label>Username<input required minLength="3" maxLength="40" autoComplete="off" name="managed-username" value={userForm.username} onChange={(event) => setUserForm({ ...userForm, username: event.target.value.toLowerCase().replace(/[^a-z0-9@._-]/g, '') })} /></label>
                  <label>Password<input required={!editingUserId} minLength="8" type="password" autoComplete="new-password" name="managed-password" readOnly={!passwordUnlocked} onFocus={() => setPasswordUnlocked(true)} value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} placeholder={editingUserId ? 'Leave empty to keep current password' : 'At least 8 characters'} /></label>
                  <label><span>Phone no. <span className="field-optional">(Optional)</span></span><input inputMode="tel" value={userForm.phone} onChange={(event) => setUserForm({ ...userForm, phone: event.target.value })} /></label>
                  <label>Role<select value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value, ccmId: '', gmId: '' })}><option value="ADMIN">ADMIN</option><option value="GM">GM</option><option value="CCM">CCM</option><option value="CRE">CRE</option><option value="FREE_SERVICE_CRE">Free-Service CRE</option></select></label>
                  <label>Dealer code<input value={userForm.dealerCode} onChange={(event) => setUserForm({ ...userForm, dealerCode: event.target.value })} /></label>
                  {userForm.role === 'CCM' && <label>GM team<select required value={userForm.gmId} onChange={(event) => setUserForm({ ...userForm, gmId: event.target.value })}><option value="">Select GM</option>{managedTeams.gms.map((gm) => <option key={gm.id} value={gm.id}>{gm.name}{gm.dealerCode ? ` · ${gm.dealerCode}` : ''}</option>)}</select></label>}
                  {['CRE', 'FREE_SERVICE_CRE'].includes(userForm.role) && <label>CCM team<select required value={userForm.ccmId} onChange={(event) => setUserForm({ ...userForm, ccmId: event.target.value })}><option value="">Select CCM</option>{managedTeams.ccms.map((ccm) => <option key={ccm.id} value={ccm.ccmId}>{ccm.name}{ccm.dealerCode ? ` · ${ccm.dealerCode}` : ''}</option>)}</select></label>}
                  {userForm.role === 'CRE' && (
                    <fieldset className="full-width-field service-permissions">
                      <legend>Service list access</legend>
                      <div className="service-permission-toggle">
                        <span>Free Service</span>
                        <button type="button" role="switch" aria-checked={userForm.freeServiceEnabled} aria-label="Free Service access" className={`permission-switch ${userForm.freeServiceEnabled ? 'is-on' : ''}`} onClick={() => setUserForm((current) => ({ ...current, freeServiceEnabled: !current.freeServiceEnabled }))}>
                          <span />
                        </button>
                      </div>
                      <div className="service-permission-toggle">
                        <span>Warranty</span>
                        <button type="button" role="switch" aria-checked={userForm.warrantyEnabled} aria-label="Warranty access" className={`permission-switch ${userForm.warrantyEnabled ? 'is-on' : ''}`} onClick={() => setUserForm((current) => ({ ...current, warrantyEnabled: !current.warrantyEnabled }))}>
                          <span />
                        </button>
                      </div>
                    </fieldset>
                  )}
                      </div>
                    </fieldset>
                    <div className="form-actions user-modal-actions">
                      <button type="button" className="outline-btn" disabled={userSaving} onClick={() => closeUserForm()}>Cancel</button>
                      <button type="submit" className="primary-btn" disabled={userSaving}>
                        <Save size={16} aria-hidden="true" />
                        {userSaving ? 'Saving…' : editingUserId ? 'Save account' : 'Create account'}
                      </button>
                    </div>
                  </form>
                </section>
              </div>
            )}
            <section className="panel customer-list-panel">
              <div className="panel-header"><h3>Managed accounts</h3><span>{managedUsersLoading ? 'Loading…' : `${managedUsers.length} accounts`}</span></div>
              <div className="table-scroll"><table><thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Role</th><th>Dealer code</th><th>Reports to</th><th>Status</th><th>Actions</th></tr></thead><tbody>
                {userTree.map(({ user, depth }) => <tr key={user.id} className={`user-row depth-${depth}`}>
                  <td><span className="user-name-cell">{depth > 0 && <span className="tree-branch" aria-hidden="true">└</span>}{user.role === 'CCM' ? <button type="button" className="text-link" onClick={() => openCcmProfile(user)}>{user.name}</button> : user.name}</span></td>
                  <td>{user.username}</td><td>{user.phone || '—'}</td><td>{user.role === 'FREE_SERVICE_CRE' ? 'Free-Service CRE' : user.role}</td><td>{user.dealerCode || '—'}</td>
                  <td>{user.role === 'CCM' ? managedTeams.gms.find((gm) => gm.id === user.gmId)?.name || '—' : ['CRE', 'FREE_SERVICE_CRE'].includes(user.role) ? managedTeams.ccms.find((ccm) => ccm.ccmId === user.ccmId)?.name || '—' : '—'}</td>
                  <td><span className={`badge ${user.status === 'active' ? 'badge-blue' : 'badge-neutral'}`}>{user.status}</span></td>
                  <td><div className="inline-actions"><button type="button" className="outline-btn compact-btn" onClick={() => startUserEdit(user)}>Edit</button>{!(currentRole === 'ADMIN' && user.id === currentUser.id) && <><button type="button" className="outline-btn compact-btn" onClick={() => toggleManagedUserStatus(user)}>{user.status === 'active' ? 'Deactivate' : 'Activate'}</button><button type="button" className="danger-outline-btn compact-btn" onClick={() => deleteManagedAccount(user)}>Delete</button></>}</div></td>
                </tr>)}
                {!managedUsersLoading && managedUsers.length === 0 && <tr><td colSpan="8" className="empty-state">No managed accounts found.</td></tr>}
              </tbody></table></div>
            </section>
          </section>
  );
}
