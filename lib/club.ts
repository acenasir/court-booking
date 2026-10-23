// Club rules. Change these to model a different venue.
export const CLUB = {
  name: "Riverside Racquet Club",
  timezone: "America/Toronto",
  openHour: 7, // first slot starts 07:00 local
  closeHour: 22, // last slot ends 22:00 local
  slotMinutes: 60,
  bookingWindowDays: 7, // how far ahead people may book
  holdSeconds: 120, // how long a slot is held while someone types their name
} as const;
