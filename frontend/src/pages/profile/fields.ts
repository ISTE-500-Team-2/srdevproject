// The profile API's address and contact keys, the choices offered for them, and the shared save signature.

import { Mail, MessageSquare, Phone, type LucideIcon } from "lucide-react";
import type { ProfileFields } from "../../lib/contracts";

// Keys the profile API stores address and contact details under.
export const ADDRESS = ["Street address", "City", "State", "Postal code"] as const;
export const CONTACT_METHOD = "Preferred contact method";
export const CONTACT_TIME = "Best time to contact";
export const METHODS: { value: string; Icon: LucideIcon }[] = [
  { value: "Email", Icon: Mail },
  { value: "Text", Icon: MessageSquare },
  { value: "Call", Icon: Phone },
];
export const TIMES = ["Morning", "Afternoon", "Evening"];
export const STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah",
  "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];
export const ZONES = [
  ["America/New_York", "Eastern Time (New York)"],
  ["America/Chicago", "Central Time (Chicago)"],
  ["America/Denver", "Mountain Time (Denver)"],
  ["America/Phoenix", "Mountain Time, no DST (Phoenix)"],
  ["America/Los_Angeles", "Pacific Time (Los Angeles)"],
  ["America/Anchorage", "Alaska Time (Anchorage)"],
  ["Pacific/Honolulu", "Hawaii Time (Honolulu)"],
];

export const text = (fields: ProfileFields | undefined, key: string) => String(fields?.[key] ?? "").trim();

export type Save = (change: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: ProfileFields;
  contactPreferences?: ProfileFields;
}) => Promise<void>;
