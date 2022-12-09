import { Client4 } from "./deps.ts";

export class CachingClient4 {
  constructor(public client: Client4) {}

  private channelCache = new Map<string, any>();
  async getChannelCached(channelId: string): Promise<any> {
    let channel = this.channelCache.get(channelId);
    if (channel) {
      return channel;
    }
    channel = await this.client.getChannel(channelId);
    this.channelCache.set(channelId, channel!);
    return channel!;
  }

  private teamCache = new Map<string, any>();
  async getTeam(teamId: string): Promise<any> {
    let team = this.teamCache.get(teamId);
    if (team) {
      return team;
    }
    team = await this.client.getTeam(teamId);
    this.teamCache.set(teamId, team!);
    return team!;
  }

  async getMyTeams(): Promise<any[]> {
    const teams = await this.client.getMyTeams();
    for (const team of teams) {
      this.teamCache.set(team.id, team);
    }
    return teams;
  }

  // Fetch all channels for all teams this user has access to
  async getAllMyChannels(): Promise<any[]> {
    const allTeams = await this.getMyTeams();
    const allChannels = await Promise.all(
      allTeams.map((team) => this.client.getMyChannels(team.id, false)),
    );
    return allChannels.flat();
  }

  private userCache = new Map<string, any>();
  async getUserCached(userId: string): Promise<any> {
    let user = this.userCache.get(userId);
    if (user) {
      return user;
    }
    user = await this.client.getUser(userId);
    this.userCache.set(userId, user!);
    return user!;
  }
}
