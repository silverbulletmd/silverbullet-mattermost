import { Client4 } from "@mattermost/client";
import { ServerChannel } from "@mattermost/types/lib/channels";
import { UserProfile } from "@mattermost/types/lib/users";
import { Team } from "@mattermost/types/lib/teams";

export class CachingClient4 {
  constructor(public client: Client4) { }

  private channelCache = new Map<string, ServerChannel>();
  async getChannelCached(channelId: string): Promise<ServerChannel> {
    let channel = this.channelCache.get(channelId);
    if (channel) {
      return channel;
    }
    channel = await this.client.getChannel(channelId);
    this.channelCache.set(channelId, channel!);
    return channel!;
  }

  private teamCache = new Map<string, Team>();
  async getTeamCached(teamId: string): Promise<Team> {
    let team = this.teamCache.get(teamId);
    if (team) {
      return team;
    }
    team = await this.client.getTeam(teamId);
    this.teamCache.set(teamId, team!);
    return team!;
  }

  private userCache = new Map<string, UserProfile>();
  async getUserCached(userId: string): Promise<UserProfile> {
    let user = this.userCache.get(userId);
    if (user) {
      return user;
    }
    user = await this.client.getUser(userId);
    this.userCache.set(userId, user!);
    return user!;
  }
}
