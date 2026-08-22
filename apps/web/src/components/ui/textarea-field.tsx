/**
 * A labelled multi-line field, matching InputField's markup so the two sit
 * together in a form without looking like different controls.
 *
 * Descriptions, notes and reasons are prose: a reason for reversing a ledger
 * entry is the only record of why the money moved, and a single-line input
 * shows about forty characters of it while hiding the rest behind a caret the
 * writer has to scroll. Anyone reviewing the entry later reads it the same way.
 *
 * `resize-y` is deliberate — the author decides how much room a long note
 * needs, and horizontal resizing would break the form's column.
 */
export function TextareaField({
  label,
  name,
  defaultValue,
  required,
  placeholder,
  rows = 3,
  minLength,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  rows?: number;
  minLength?: number;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required ? (
          <span className="text-red-500 ms-1">*</span>
        ) : (
          <span className="text-gray-400 ms-1 text-xs font-normal">(Optional)</span>
        )}
      </label>
      <textarea
        name={name}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        rows={rows}
        minLength={minLength}
        className="w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
    </div>
  );
}
