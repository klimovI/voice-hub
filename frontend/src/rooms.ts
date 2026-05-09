export type RoomSlug = 'room1' | 'room2' | 'room3';
export const ROOM_SLUGS: readonly RoomSlug[] = ['room1', 'room2', 'room3'];
export const ROOM_LABELS: Record<RoomSlug, string> = {
  room1: '1',
  room2: '2',
  room3: '3',
};
export const DEFAULT_ROOM_SLUG: RoomSlug = 'room1';
export function isRoomSlug(v: unknown): v is RoomSlug {
  return typeof v === 'string' && (ROOM_SLUGS as readonly string[]).includes(v);
}
