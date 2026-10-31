export default function SpacerRow({ height, columns }) {
  if (!height) return null;
  return (
    <tr aria-hidden="true" className="virtual-spacer">
      <td colSpan={columns} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}
