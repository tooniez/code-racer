import type { Race, RaceParticipant } from "@code-racer/app/src/lib/prisma";
import { prisma } from "@code-racer/app/src/lib/prisma";
import { RaceStatusType } from "./types";
import { type Server } from "socket.io";
import { siteConfig } from "@code-racer/app/src/config/site";
import {
  PositionUpdateEvent,
  type ClientToServerEvents,
  positionUpdateEvent,
} from "./events/client-to-server";
import { type ServerToClientEvents } from "./events/server-to-client";
import {
  UserRaceEnterEvent,
  UserRaceLeaveEvent,
  userRacePresenceEvent,
} from "./events/common";

type ParticipantsMap = Map<
  //this is the socketId
  string,
  {
    id: RaceParticipant["id"];
    position: number;
    finishedAt: number | null;
  }
>;

export class Game {
  private static readonly START_GAME_COUNTDOWN = 5;
  private static readonly MAX_PARTICIPANTS_PER_RACE =
    siteConfig.multiplayer.maxParticipantsPerRace;
  private static readonly GAME_LOOP_INTERVAL = 500;
  private static readonly GAME_MAX_POSITION = 100;
  private activeCountdowns = new Map<Race["id"], Promise<void>>();

  private races = new Map<
    Race["id"],
    {
      status: RaceStatusType;
      participants: ParticipantsMap;
    }
  >();

  constructor(
    private server: Server<ClientToServerEvents, ServerToClientEvents>,
  ) {
    this.initialize();
  }

  private initialize() {
    this.server.on("connection", (socket) => {
      socket.on("UserRaceEnter", (payload) => {
        socket.join(`RACE_${payload.raceId}`)
        this.handlePlayerEnterRace(payload);
      });
      socket.on("disconnect", () => {
        for (const [raceId, race] of this.races.entries()) {
          const participant = race.participants.get(socket.id);
          if (participant) {
            this.handlePlayerLeaveRace({
              participantId: participant.id,
              raceId,
              socketId: socket.id,
            });
          }
        }
      });
      socket.on("PositionUpdate", (payload: PositionUpdateEvent) => {
        // console.log("Received payload: ", payload)
        const parsedPayload = positionUpdateEvent.parse(payload);
        // console.log(
        // `Race participant position payload: ${parsedPayload}`,
        // )
        this.handleParticipantPositionPayload(parsedPayload);
      });
    });
  }

  private serializeParticipants(participants: ParticipantsMap) {
    return Array.from(participants.entries()).map(
      ([socketId, { id, position, finishedAt }]) => ({
        id,
        socketId,
        position,
        finishedAt,
      }),
    );
  }

  private createRaceWithParticipant(
    raceId: string,
    participant: { id: string; socketId: string },
  ) {
    return this.races.set(raceId, {
      status: "waiting",
      participants: new Map().set(participant.socketId, {
        id: participant.id,
        position: 0,
        finishedAt: null,
      }),
    });
  }

  private async handlePlayerEnterRace(payload: UserRaceEnterEvent) {
    const parsedPayload = userRacePresenceEvent.parse(payload);

    // console.log("Player entering race:", payload)
    const race = this.races.get(parsedPayload.raceId);

    if (!race) {
      this.createRaceWithParticipant(parsedPayload.raceId, {
        id: parsedPayload.participantId,
        socketId: parsedPayload.socketId,
      });
    } else if (race.participants.size + 1 > Game.MAX_PARTICIPANTS_PER_RACE) {
      return this.emitRaceFull(parsedPayload.socketId);
    } else {
      // console.log("Starting a race", parsedPayload.raceId)
      race.participants.set(parsedPayload.socketId, {
        id: parsedPayload.participantId,
        position: 0,
        finishedAt: null,
      });
      this.startRaceCountdown(parsedPayload.raceId);
    }

    // console.log({ raceId: parsedPayload.raceId }, "\n")
    // console.log("Races: ", this.races)

    // Emit to all players in the room that a new player has joined.
    this.server
      .to(`RACE_${parsedPayload.raceId}`)
      .emit("UserRaceEnter", parsedPayload);
  }

  private emitRaceFull(socketId: string) {
    this.server.sockets.sockets.get(socketId)?.emit("UserEnterFullRace");
  }

  private handlePlayerLeaveRace(payload: UserRaceLeaveEvent) {
    const parsedPayload = userRacePresenceEvent.parse(payload);
    // console.log("Player leaving race: ", parsedPayload)

    const race = this.races.get(parsedPayload.raceId);

    if (!race) {
      console.warn("Player left a race that doesn't exist.", {
        raceId: parsedPayload.raceId,
        participantId: parsedPayload.participantId,
        time: new Date(),
      });
      return;
    }

    race.participants.delete(parsedPayload.socketId);

    this.server
      .to(`RACE_${parsedPayload.raceId}`)
      .emit("UserRaceLeave", parsedPayload);

    const isRaceEnded = this.isRaceEnded(parsedPayload.raceId);

    if (isRaceEnded) {
      void this.endRace(parsedPayload.raceId);
    }
    // console.log("Races: ", this.races)
  }

  private startRace(raceId: string) {
    const interval = setInterval(() => {
      const race = this.races.get(raceId);
      if (!race) {
        clearInterval(interval);
        return;
      }

      if (race.status !== "running") {
        race.status = "running";
        // console.log("Started race: ", raceId)
        void prisma.race.update({
          where: {
            id: raceId,
          },
          data: {
            startedAt: new Date(),
          },
        });
      }

      // console.log("Emitting game loop for race:", raceId)
      this.server.to(`RACE_${raceId}`).emit("GameStateUpdate", {
        raceState: {
          id: raceId,
          status: race.status,
          participants: this.serializeParticipants(race.participants),
        },
      });
    }, Game.GAME_LOOP_INTERVAL);
  }

  private endRace(raceId: string) {
    const race = this.races.get(raceId);

    if (!race) {
      console.warn("Trying to end a race that doesn't exist.", {
        raceId,
        time: new Date(),
      });
      return;
    }

    race.status = "finished";

    this.server.to(`RACE_${raceId}`).emit("GameStateUpdate", {
      raceState: {
        id: raceId,
        status: race.status,
        participants: this.serializeParticipants(race.participants),
      },
    });

    this.races.delete(raceId);

    void prisma.race.update({
      where: {
        id: raceId,
      },
      data: {
        endedAt: new Date(),
      },
    });
  }

  private startRaceCountdown(raceId: string) {
    if (this.activeCountdowns.has(raceId)) {
      return;
    }

    const countdownPromise = new Promise<void>((resolve, reject) => {
      let countdown = Game.START_GAME_COUNTDOWN;
      const race = this.races.get(raceId);

      if (!race) {
        console.warn(
          "Trying to start a countdown for a race that doesn't exist.",
          {
            raceId,
            time: new Date(),
          },
        );
        return reject();
      }

      const interval = setInterval(() => {
        this.server.to(`RACE_${raceId}`).emit("GameStateUpdate", {
          raceState: {
            participants: this.serializeParticipants(race.participants),
            status: "countdown",
            id: raceId,
            countdown,
          },
        });

        // console.log(`Race: ${raceId} Countdown: ${countdown}`)
        countdown--;

        if (countdown === 0) {
          this.server.to(`RACE_${raceId}`).emit("GameStateUpdate", {
            raceState: {
              participants: this.serializeParticipants(race.participants),
              status: "countdown",
              id: raceId,
              countdown,
            },
          });

          this.startRace(raceId);
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    }).finally(() => {
      this.activeCountdowns.delete(raceId);
    });

    this.activeCountdowns.set(raceId, countdownPromise);
  }

  private handleParticipantPositionPayload(
    payload: PositionUpdateEvent,
  ) {
    const race = this.races.get(payload.raceId);

    if (!race) {
      console.warn(
        "Trying to update a participant position on a race that doesn't exist.",
        {
          raceId: payload.raceId,
          participant: payload.participantId,
          time: new Date(),
        },
      );
      return;
    }

    const parsedPayload = positionUpdateEvent.parse(payload);

    const participant = race.participants.get(parsedPayload.socketId);

    //TODO: Log a warning or handle exception
    if (!participant) {
      console.warn("Trying to update a participant that doesn't exist.", {
        raceId: parsedPayload.raceId,
        participant: parsedPayload.participantId,
        time: new Date(),
      });
      return;
    }

    participant.position = parsedPayload.position;

    if (participant.position >= Game.GAME_MAX_POSITION) {
      if (participant.finishedAt) return;
      participant.finishedAt = new Date().getTime();
    }

    const isRaceEnded = this.isRaceEnded(parsedPayload.raceId);

    if (isRaceEnded) {
      this.endRace(parsedPayload.raceId);
    }
  }

  private isRaceEnded(raceId: string) {
    const race = this.races.get(raceId);
    if (!race) return true;

    // checks if every participant has finished the race
    let finishedParticipants = 0;
    for (const participant of race.participants.values()) {
      if (participant.position >= Game.GAME_MAX_POSITION) {
        finishedParticipants++;
      }
    }

    return finishedParticipants >= race.participants.size;
  }
}
