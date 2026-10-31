export default function ImportErrors({ errors }) {
  return (
    <ul className="import-error-list">
      {errors.map((error, index) => (
        <li key={`${error.rowNumber}-${error.errorCode}-${index}`}>
          <strong className={`import-status ${error.status || 'rejected'}`}>{error.status || error.errorCode}</strong>
          <span>Row {error.rowNumber}{error.vin ? ` · ${error.vin}` : ''}: {error.errorMessage}</span>
        </li>
      ))}
    </ul>
  );
}
