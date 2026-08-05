const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})([+-])(\d{2}):(\d{2})$/u;

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function three(value: number): string {
  return String(value).padStart(3, "0");
}

/** Formats a Date using the host's numeric local timezone offset. */
export function currentLinearDescriptionTimestamp(now = new Date()): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("linear_description_timestamp_invalid");
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteOffset = Math.abs(offsetMinutes);
  return [
    `${String(now.getFullYear()).padStart(4, "0")}-${two(now.getMonth() + 1)}-${two(now.getDate())}`,
    `T${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${three(now.getMilliseconds())}`,
    `${sign}${two(Math.floor(absoluteOffset / 60))}:${two(absoluteOffset % 60)}`,
  ].join("");
}

/** Accepts only the canonical local RFC3339 form used in Root descriptions. */
export function parseLinearDescriptionTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("linear_description_timestamp_invalid");
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) throw new Error("linear_description_timestamp_invalid");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondText, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(millisecondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) throw new Error("linear_description_timestamp_invalid");

  // Date.UTC treats years 0-99 as 1900-1999, so set the year separately.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, millisecond);
  const offset = (offsetHour * 60 + offsetMinute) * (sign === "-" ? -1 : 1);
  const instant = new Date(probe.getTime() - offset * 60_000);
  if (Number.isNaN(instant.getTime())) throw new Error("linear_description_timestamp_invalid");
  const roundTrip = new Date(instant.getTime() + offset * 60_000);
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute
    || roundTrip.getUTCSeconds() !== second
    || roundTrip.getUTCMilliseconds() !== millisecond
  ) throw new Error("linear_description_timestamp_invalid");
  return value;
}
