export function appointmentConversionRatePercent(appointments, calls) {
  return calls > 0 ? Math.round((appointments / calls) * 100) : 0;
}
