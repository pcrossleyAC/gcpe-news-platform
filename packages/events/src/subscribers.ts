import { z } from "zod";

const subscriberSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  secret: z.string().min(1),
  types: z.array(z.string().min(1)).min(1),
});

export type SubscriberConfig = z.infer<typeof subscriberSchema>;

export function parseSubscribers(json: string | undefined): SubscriberConfig[] {
  if (!json) return [];
  return z.array(subscriberSchema).parse(JSON.parse(json));
}

export function subscribersFor(type: string, subscribers: SubscriberConfig[]): SubscriberConfig[] {
  return subscribers.filter((s) => s.types.includes("*") || s.types.includes(type));
}
