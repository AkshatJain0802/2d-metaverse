import { WebSocket } from 'ws';
import { RoomManager } from './RoomManager';
import { OutgoingMessage } from './types';
import client from '@repo/db/client';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { JWT_PASSWORD } from './config';

function getRandomString(length: number) {
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

export class User {
  public id: string;
  public userId?: string;
  private spaceId?: string;
  private mapId?: string;
  private roomType?: 'space' | 'map';
  public x: number;
  public y: number;
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    this.id = getRandomString(10);
    this.x = 0;
    this.y = 0;
    this.ws = ws;
    this.initHandlers();
  }

  initHandlers() {
    this.ws.on('message', async (data) => {
      console.log(data);
      const parsedData = JSON.parse(data.toString());
      console.log(parsedData);
      console.log('parsedData');
      switch (parsedData.type) {
        case 'join':
          console.log('join received');
          const spaceId = parsedData.payload.spaceId;
          const mapId = parsedData.payload.mapId;
          const token = parsedData.payload.token;

          // Validate required fields - either spaceId or mapId but not both
          if ((!spaceId && !mapId) || (spaceId && mapId) || !token) {
            console.log(
              'Missing or conflicting spaceId/mapId or token in join request'
            );
            this.ws.close();
            return;
          }

          let userId;
          try {
            userId = (jwt.verify(token, JWT_PASSWORD) as JwtPayload).userId;
          } catch (error) {
            console.log(
              'Invalid token:',
              error instanceof Error ? error.message : 'Unknown error'
            );
            this.ws.close();
            return;
          }

          if (!userId) {
            console.log('No userId found in token');
            this.ws.close();
            return;
          }

          this.userId = userId;

          // Handle space joining
          if (spaceId) {
            const space = await client.space.findFirst({
              where: {
                id: spaceId,
              },
            });

            if (!space) {
              this.ws.close();
              return;
            }

            this.spaceId = spaceId;
            this.roomType = 'space';
            RoomManager.getInstance().addUser(`space_${spaceId}`, this);

            // Spawn at a safe position within the space bounds
            this.x = Math.floor(Math.random() * space.width);
            this.y = Math.floor(Math.random() * space.height);

            // Fetch recent messages (last 50) for this space
            const recentMessages = await client.message.findMany({
              where: {
                spaceId: spaceId,
              },
              orderBy: {
                createdAt: 'desc',
              },
              take: 50,
            });

            // Reverse to show oldest first
            const messages = recentMessages.reverse().map((msg) => ({
              id: msg.id,
              userId: msg.userId.toString(),
              displayName: msg.displayName,
              text: msg.text,
              createdAt: msg.createdAt.toISOString(),
            }));

            this.send({
              type: 'space-joined',
              payload: {
                spawn: {
                  x: this.x,
                  y: this.y,
                },
                userId: this.userId,
                users:
                  RoomManager.getInstance()
                    .rooms.get(`space_${spaceId}`)
                    ?.filter((x) => x.id !== this.id)
                    ?.map((u) => ({
                      id: u.id,
                      userId: u.userId,
                      x: u.x,
                      y: u.y,
                    })) ?? [],
                messages: messages,
              },
            });

            RoomManager.getInstance().broadcast(
              {
                type: 'user-joined',
                payload: {
                  userId: this.userId,
                  x: this.x,
                  y: this.y,
                },
              },
              this,
              `space_${this.spaceId}`
            );
          }

          // Handle map joining
          if (mapId) {
            const map = await client.map.findFirst({
              where: {
                id: mapId,
              },
            });

            if (!map) {
              this.ws.close();
              return;
            }

            this.mapId = mapId;
            this.roomType = 'map';
            RoomManager.getInstance().addUser(`map_${mapId}`, this);

            // Track map visit for the user
            if (this.userId) {
              try {
                await client.userMapVisit.upsert({
                  where: {
                    userId_mapId: {
                      userId: parseInt(this.userId),
                      mapId: mapId,
                    },
                  },
                  update: {
                    visitedAt: new Date(),
                  },
                  create: {
                    userId: parseInt(this.userId),
                    mapId: mapId,
                  },
                });
              } catch (error) {
                console.error('Failed to track map visit:', error);
              }
            }

            // Spawn at a safe position within the map bounds
            this.x = Math.floor(Math.random() * map.width);
            this.y = Math.floor(Math.random() * map.height);

            // Fetch recent messages (last 50) for this map
            const recentMessages = await client.message.findMany({
              where: {
                mapId: mapId,
              },
              orderBy: {
                createdAt: 'desc',
              },
              take: 50,
            });

            // Reverse to show oldest first
            const messages = recentMessages.reverse().map((msg) => ({
              id: msg.id,
              userId: msg.userId.toString(),
              displayName: msg.displayName,
              text: msg.text,
              createdAt: msg.createdAt.toISOString(),
            }));

            this.send({
              type: 'map-joined',
              payload: {
                spawn: {
                  x: this.x,
                  y: this.y,
                },
                userId: this.userId,
                users:
                  RoomManager.getInstance()
                    .rooms.get(`map_${mapId}`)
                    ?.filter((x) => x.id !== this.id)
                    ?.map((u) => ({
                      id: u.id,
                      userId: u.userId,
                      x: u.x,
                      y: u.y,
                    })) ?? [],
                messages: messages,
              },
            });

            RoomManager.getInstance().broadcast(
              {
                type: 'user-joined',
                payload: {
                  userId: this.userId,
                  x: this.x,
                  y: this.y,
                },
              },
              this,
              `map_${this.mapId}`
            );
          }
          break;
        case 'move':
          const moveX = parsedData.payload.x;
          const moveY = parsedData.payload.y;
          const isTeleport = parsedData.payload.teleport || false;
          const xDisplacement = Math.abs(this.x - moveX);
          const yDisplacement = Math.abs(this.y - moveY);

          if (isTeleport) {
            console.log(
              `Teleport request: ${this.userId} from (${this.x}, ${this.y}) to (${moveX}, ${moveY})`
            );
          }

          // Validate that user is in either a space or map
          if (!this.spaceId && !this.mapId) {
            return;
          }

          const isValidMove = await this.validateMovement(
            moveX,
            moveY,
            xDisplacement,
            yDisplacement,
            isTeleport
          );

          if (isValidMove) {
            // Update position immediately
            this.x = moveX;
            this.y = moveY;

            // Determine the room key for broadcasting
            const roomKey = this.spaceId
              ? `space_${this.spaceId}`
              : `map_${this.mapId}`;

            // Broadcast to other users FIRST for speed
            RoomManager.getInstance().broadcast(
              {
                type: 'movement',
                payload: {
                  userId: this.userId,
                  x: this.x,
                  y: this.y,
                },
              },
              this,
              roomKey
            );

            // Send acknowledgment to the moving user
            this.send({
              type: 'movement-accepted',
              payload: {
                x: this.x,
                y: this.y,
              },
            });
            return;
          }

          // Movement rejected - send current position
          this.send({
            type: 'movement-rejected',
            payload: {
              x: this.x,
              y: this.y,
            },
          });
          break;

        case 'chat':
          // Chat message broadcasting and persistence
          try {
            const text = String(parsedData.payload?.text || '').slice(0, 2000);
            const displayName =
              parsedData.payload?.displayName || String(this.userId || this.id);

            if ((!this.spaceId && !this.mapId) || !this.userId || !text.trim())
              return;

            const roomKey = this.spaceId
              ? `space_${this.spaceId}`
              : `map_${this.mapId}`;

            if (this.spaceId) {
              // For spaces: persist message to database
              const savedMessage = await client.message.create({
                data: {
                  spaceId: parseInt(this.spaceId),
                  userId: parseInt(this.userId),
                  displayName,
                  text: text.trim(),
                },
              });

              const chatPayload = {
                id: savedMessage.id,
                userId: this.userId,
                displayName,
                text: text.trim(),
                createdAt: savedMessage.createdAt.toISOString(),
              };

              // Send to sender immediately
              this.send({
                type: 'chat',
                payload: chatPayload,
              });

              // Broadcast to other users in the room
              RoomManager.getInstance().broadcast(
                {
                  type: 'chat',
                  payload: chatPayload,
                },
                this,
                roomKey
              );
            } else if (this.mapId) {
              // For maps: persist message to database (same as spaces)
              const savedMessage = await client.message.create({
                data: {
                  mapId: parseInt(this.mapId),
                  userId: parseInt(this.userId),
                  displayName,
                  text: text.trim(),
                },
              });

              const chatPayload = {
                id: savedMessage.id,
                userId: this.userId,
                displayName,
                text: text.trim(),
                createdAt: savedMessage.createdAt.toISOString(),
              };

              // Send to sender immediately
              this.send({
                type: 'chat',
                payload: chatPayload,
              });

              // Broadcast to other users in the room
              RoomManager.getInstance().broadcast(
                {
                  type: 'chat',
                  payload: chatPayload,
                },
                this,
                roomKey
              );
            }
          } catch (err) {
            console.error('Error handling chat message:', err);
          }
          break;
      }
    });
  }

  async validateMovement(
    newX: number,
    newY: number,
    xDisplacement: number,
    yDisplacement: number,
    isTeleport: boolean = false
  ): Promise<boolean> {
    try {
      // 1. Movement validation: allow teleport or single step movement
      if (
        !isTeleport &&
        !(
          (xDisplacement == 1 && yDisplacement == 0) ||
          (xDisplacement == 0 && yDisplacement == 1)
        )
      ) {
        return false;
      }

      // 2. Quick check: collision with other players (no DB query needed)
      const roomKey = this.spaceId
        ? `space_${this.spaceId}`
        : `map_${this.mapId}`;
      const roomUsers = RoomManager.getInstance().rooms.get(roomKey) || [];
      for (const otherUser of roomUsers) {
        if (
          otherUser.id !== this.id &&
          otherUser.x === newX &&
          otherUser.y === newY
        ) {
          return false; // Player collision
        }
      }

      // 3. Get room data based on type
      if (this.spaceId) {
        // Handle space validation
        const space = await client.space.findFirst({
          where: { id: parseInt(this.spaceId) },
          select: {
            width: true,
            height: true,
            elements: {
              select: {
                x: true,
                y: true,
                element: {
                  select: {
                    width: true,
                    height: true,
                  },
                },
              },
            },
          },
        });

        if (!space) {
          return false;
        }

        // Check boundaries
        if (
          newX < 0 ||
          newX >= space.width ||
          newY < 0 ||
          newY >= space.height
        ) {
          return false;
        }

        // Check element collisions
        for (const spaceElement of space.elements) {
          const element = spaceElement.element;

          if (
            newX >= spaceElement.x &&
            newX < spaceElement.x + element.width &&
            newY >= spaceElement.y &&
            newY < spaceElement.y + element.height
          ) {
            return false; // Element collision
          }
        }
      } else if (this.mapId) {
        // Handle map validation
        const map = await client.map.findFirst({
          where: { id: parseInt(this.mapId) },
          select: {
            width: true,
            height: true,
            mapElements: {
              select: {
                x: true,
                y: true,
                element: {
                  select: {
                    width: true,
                    height: true,
                  },
                },
              },
            },
          },
        });

        if (!map) {
          return false;
        }

        // Check boundaries
        if (newX < 0 || newX >= map.width || newY < 0 || newY >= map.height) {
          return false;
        }

        // Check element collisions
        for (const mapElement of map.mapElements) {
          const element = mapElement.element;

          if (
            newX >= mapElement.x &&
            newX < mapElement.x + element.width &&
            newY >= mapElement.y &&
            newY < mapElement.y + element.height
          ) {
            return false; // Element collision
          }
        }
      } else {
        return false; // Neither space nor map
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  destroy() {
    const roomKey = this.spaceId
      ? `space_${this.spaceId}`
      : `map_${this.mapId}`;

    if (roomKey && (this.spaceId || this.mapId)) {
      RoomManager.getInstance().broadcast(
        {
          type: 'user-left',
          payload: {
            userId: this.userId,
          },
        },
        this,
        roomKey
      );
      RoomManager.getInstance().removeUser(this, roomKey);
    }
  }

  send(payload: OutgoingMessage) {
    this.ws.send(JSON.stringify(payload));
  }
}
