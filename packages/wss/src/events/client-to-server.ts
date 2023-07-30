import {
  Language,
  snippetLanguages,
} from "@code-racer/app/src/config/languages";
import { UserRacePresencePayload } from "./common";

export type PositionUpdatePayload = UserRacePresencePayload & {
  raceId: string;
  position: number;
};

export type UserRaceRequestPayload = {
  language: string;
  userId?: string;
};

export type UserCreateRoomPayload = {
  roomId: string;
  language: Language;
  userId: string;
};

export type UserRoomRaceRequestPayload = {
  raceId: string;
};

export interface ClientToServerEvents {
  PositionUpdate: (payload: PositionUpdatePayload) => void;
  UserRaceEnter: (payload: UserRacePresencePayload) => void;
  UserRaceLeave: (payload: UserRacePresencePayload) => void;
  UserRaceRequest: (payload: UserRaceRequestPayload) => void;
  UserCreateRoom: (payload: UserCreateRoomPayload) => void;
  UserRoomRaceRequest: (payload: UserRoomRaceRequestPayload) => void;
}
