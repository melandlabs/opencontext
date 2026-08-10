import { Client, ApiError } from "@xdevplatform/xdk";
import { AppError } from "@openloomi/shared/errors";
import type { ExtractedMessageInfo } from "@openloomi/integrations/channels/sources/types";
import type { Messages } from "@openloomi/integrations/channels";

type XAdapterOptions = {
  botId: string;
  accessToken: string;
  userId: string;
  username?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  clientId?: string;
  clientSecret?: string;
  onCredentialsUpdated?: (credentials: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
  }) => Promise<void>;
};

type XDMMessage = {
  id: string;
  text?: string;
  event_time?: string;
  sender_id?: string;
};

type XDMConversation = {
  conversation_id: string;
  messages?: XDMMessage[];
  participants?: { user_id: string }[];
};

export class XAdapter {
  private client: Client;
  private userId: string;
  private username?: string | null;
  private botId: string;
  private refreshToken: string | null;
  private expiresAt: number | null;
  private clientId?: string;
  private clientSecret?: string;
  private onCredentialsUpdated?:
    | ((credentials: {
        accessToken: string;
        refreshToken?: string | null;
        expiresAt?: number | null;
      }) => Promise<void>)
    | undefined;

  constructor(options: XAdapterOptions) {
    this.userId = options.userId;
    this.username = options.username ?? null;
    this.botId = options.botId;
    this.refreshToken = options.refreshToken ?? null;
    this.expiresAt = options.expiresAt ?? null;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.onCredentialsUpdated = options.onCredentialsUpdated;
    this.client = new Client({ accessToken: options.accessToken });
  }

  /**
   * Check if the access token is expired or about to expire (within 5 minutes).
   */
  private isTokenExpiringSoon(): boolean {
    if (!this.expiresAt) return false;
    return this.expiresAt - Date.now() < 5 * 60 * 1000;
  }

  /**
   * Ensure we have a valid access token, refreshing if necessary.
   */
  private async ensureAccessToken(): Promise<string> {
    if (!this.isTokenExpiringSoon()) {
      const token = this.client.accessToken;
      if (!token) {
        throw new AppError(
          "unauthorized:x_token_expired",
          `Bot ${this.botId}: X access token is missing.`,
        );
      }
      return token;
    }
    return this.refreshAccessToken();
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      console.warn(
        `[Bot ${this.botId}] No refresh token available for X, cannot refresh.`,
      );
      const token = this.client.accessToken;
      if (!token) {
        throw new AppError(
          "unauthorized:x_token_expired",
          `Bot ${this.botId}: X access token is missing and cannot be refreshed.`,
        );
      }
      return token;
    }

    console.log(`[Bot ${this.botId}] Refreshing X access token...`);

    try {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });

      const response = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        },
        body: params,
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(
          `[Bot ${this.botId}] X token refresh failed (${response.status}): ${text}`,
        );
        const token = this.client.accessToken;
        if (!token) {
          throw new AppError(
            "unauthorized:x_token_expired",
            `Bot ${this.botId}: X access token is missing after refresh failure.`,
          );
        }
        return token;
      }

      const data = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };

      const newAccessToken =
        data.access_token ??
        this.client.accessToken ??
        (() => {
          throw new AppError(
            "unauthorized:x_token_expired",
            `Bot ${this.botId}: X access token is missing (both new and existing).`,
          );
        })();
      const newRefreshToken = data.refresh_token ?? this.refreshToken;
      const newExpiresAt = data.expires_in
        ? Date.now() + data.expires_in * 1000
        : this.expiresAt;

      // Update in-memory state
      this.client = new Client({ accessToken: newAccessToken });
      this.refreshToken = newRefreshToken;
      this.expiresAt = newExpiresAt ?? null;

      // Persist updated credentials to DB
      if (this.onCredentialsUpdated) {
        try {
          await this.onCredentialsUpdated({
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresAt: newExpiresAt ?? undefined,
          });
        } catch (err) {
          console.error(
            `[Bot ${this.botId}] Failed to persist refreshed X credentials:`,
            err,
          );
        }
      }

      console.log(`[Bot ${this.botId}] X access token refreshed successfully.`);
      return newAccessToken;
    } catch (error) {
      console.error(
        `[Bot ${this.botId}] X token refresh threw an error:`,
        error,
      );
      const token = this.client.accessToken;
      if (!token) {
        throw new AppError(
          "unauthorized:x_token_expired",
          `Bot ${this.botId}: X access token is missing after refresh error.`,
        );
      }
      return token;
    }
  }

  /**
   * Wrap SDK calls to handle ApiError → AppError conversion.
   */
  private async withTokenRefresh<T>(
    fn: () => Promise<T>,
    name: string,
  ): Promise<T> {
    await this.ensureAccessToken();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiError) {
        console.error(
          `[Bot ${this.botId}] X SDK error (${name}): ${error.status} ${error.statusText}`,
        );
        console.error(
          `[Bot ${this.botId}] X SDK error data:`,
          JSON.stringify(error.data, null, 2),
        );
        if (error.status === 401) {
          throw new AppError(
            "unauthorized:x_token_expired",
            "X access token expired. Please reconnect X in Settings > Integrations.",
          );
        }
        const data = error.data as
          | { detail?: string; title?: string; errors?: unknown[] }
          | undefined;
        const errorMsg =
          data?.detail ?? data?.title ?? `X API error (${error.status})`;
        if (data?.errors && Array.isArray(data.errors)) {
          console.error(
            `[Bot ${this.botId}] X API errors:`,
            JSON.stringify(data.errors, null, 2),
          );
        }
        throw new AppError("bad_request:bot", `X API error: ${errorMsg}`);
      }
      throw error;
    }
  }

  async getMessagesByTime(since: number): Promise<ExtractedMessageInfo[]> {
    const token = await this.ensureAccessToken();
    const fetchWithToken = async <T>(
      path: string,
      params?: Record<string, string>,
    ): Promise<T> => {
      const search = params ? `?${new URLSearchParams(params).toString()}` : "";
      const url = `https://api.twitter.com/2/${path}${search}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        console.error(`[Bot ${this.botId}] X API error ${path}: ${text}`);
        if (response.status === 401) {
          throw new AppError(
            "unauthorized:x_token_expired",
            "X access token expired. Please reconnect X in Settings > Integrations.",
          );
        }
        throw new AppError(
          "bad_request:bot",
          `X API failed (${response.status})`,
        );
      }
      return response.json() as Promise<T>;
    };

    const conversationsResponse = await fetchWithToken<{
      data?: XDMConversation[];
    }>("dm_conversations/with", { max_results: "20" }).catch(() => ({
      data: [],
    }));

    const conversations = conversationsResponse.data ?? [];
    const result: ExtractedMessageInfo[] = [];

    for (const convo of conversations) {
      const convoId = convo.conversation_id;
      if (!convoId) continue;
      const messagesResp = await fetchWithToken<{ data?: XDMMessage[] }>(
        `dm_conversations/${convoId}/messages`,
        { max_results: "50" },
      ).catch(() => ({ data: [] }));

      const messages = messagesResp.data ?? [];
      for (const message of messages) {
        const created = message.event_time
          ? new Date(message.event_time).getTime()
          : Date.now();
        if (created < since * 1000) continue;

        const senderId = message.sender_id ?? "";
        const isSelf = senderId === this.userId;
        const sender =
          isSelf && this.username
            ? this.username
            : isSelf
              ? "Me"
              : senderId || "X User";
        const chatName = `DM ${convoId}`;

        result.push({
          chatType: "private",
          chatName,
          sender,
          text: message.text ?? "",
          timestamp: Math.floor(created / 1000),
          attachments: [],
        });
      }
    }

    return result;
  }

  async sendMessages(
    _channel: "private",
    recipients: string[],
    messages: Messages,
  ): Promise<void> {
    if (recipients.length === 0) {
      throw new AppError("bad_request:bot", "No X DM recipient provided.");
    }
    const textPart = messages.find(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
    if (!textPart) {
      throw new AppError("bad_request:bot", "X DM requires text content.");
    }

    const body = {
      direct_message: {
        text: textPart,
      },
    };

    const token = await this.ensureAccessToken();
    for (const recipient of recipients) {
      const response = await fetch(
        `https://api.twitter.com/2/dm_conversations/with/${recipient}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const text = await response.text();
        console.error(
          `[Bot ${this.botId}] X DM send failed: ${response.status} ${text}`,
        );
        if (response.status === 401) {
          throw new AppError(
            "unauthorized:x_token_expired",
            "X access token expired. Please reconnect X in Settings > Integrations.",
          );
        }
        throw new AppError(
          "bad_request:bot",
          `X DM send failed (${response.status})`,
        );
      }
    }
  }

  async kill(): Promise<void> {
    // nothing to cleanup
  }

  // ============ Tweet Operations ============

  /**
   * Post a new tweet (text only)
   */
  async postTweet(
    text: string,
    quoteTweetId?: string,
  ): Promise<{ id: string; text: string }> {
    console.log(
      `[X postTweet] userId=${this.userId} username=${this.username} botId=${this.botId}`,
    );
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.create({
        text,
        ...(quoteTweetId && { quoteTweetId }),
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(`[X postTweet] failed: ${JSON.stringify(err)}`);
        throw new AppError(
          "bad_request:bot",
          `X postTweet failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      const data = result.data as { id: string; text: string } | undefined;
      if (!data) {
        throw new AppError("bad_request:bot", "X postTweet returned no data");
      }
      return data;
    }, "posts.create");
  }

  /**
   * Post a tweet with images
   */
  async postTweetWithMedia(
    text: string,
    mediaIds: string[],
    quoteTweetId?: string,
  ): Promise<{ id: string; text: string }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.create({
        text,
        media: { media_ids: mediaIds },
        ...(quoteTweetId && { quoteTweetId }),
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X postTweetWithMedia failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X postTweetWithMedia failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      const data = result.data as { id: string; text: string } | undefined;
      if (!data) {
        throw new AppError(
          "bad_request:bot",
          "X postTweetWithMedia returned no data",
        );
      }
      return data;
    }, "posts.create");
  }

  // ============ Media Operations ============

  /**
   * Upload media to X and return media ID
   */
  async uploadMedia(mediaUrl: string): Promise<string> {
    return this.withTokenRefresh(async () => {
      // Download the media file from the URL
      const response = await fetch(mediaUrl);
      if (!response.ok) {
        throw new AppError(
          "bad_request:bot",
          `Failed to download media from ${mediaUrl}: ${response.status}`,
        );
      }
      const buffer = await response.arrayBuffer();
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";

      // Determine media category based on content type
      let category: "tweet_image" | "tweet_video" | "tweet_gif" = "tweet_image";
      if (contentType.startsWith("video/")) {
        category = "tweet_video";
      } else if (contentType.startsWith("image/gif")) {
        category = "tweet_gif";
      }

      // Upload using SDK
      const result = await this.client.media.upload({
        file: Buffer.from(buffer),
        mimeType: contentType,
        category,
      });

      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X uploadMedia failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X uploadMedia failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }

      const data = result.data as { media_id_string?: string } | undefined;
      if (!data?.media_id_string) {
        throw new AppError(
          "bad_request:bot",
          "X uploadMedia returned no media_id",
        );
      }
      return data.media_id_string;
    }, "media.upload");
  }

  // ============ Tweet Operations (Extended) ============

  /**
   * Get a tweet by ID
   */
  async getTweetById(tweetId: string): Promise<{
    id: string;
    text: string;
    authorId: string;
    createdAt: string;
    likeCount?: number;
    retweetCount?: number;
    impressionCount?: number;
  }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.getById(tweetId, {
        tweetFields: ["createdAt", "authorId", "publicMetrics"],
      });
      const tweet = result.data as any;
      if (!tweet) {
        throw new AppError("bad_request:bot", "Tweet not found");
      }
      return {
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.authorId ?? tweet.author_id ?? "",
        createdAt: tweet.createdAt ?? tweet.created_at ?? "",
        likeCount:
          tweet.publicMetrics?.likeCount ?? tweet.public_metrics?.like_count,
        retweetCount:
          tweet.publicMetrics?.retweetCount ??
          tweet.public_metrics?.retweet_count,
        impressionCount:
          tweet.publicMetrics?.impressionCount ??
          tweet.public_metrics?.impression_count,
      };
    }, "posts.getById");
  }

  /**
   * Delete a tweet
   */
  async deleteTweet(tweetId: string): Promise<{ deleted: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.delete(tweetId);
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X deleteTweet failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X deleteTweet failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { deleted: true };
    }, "posts.delete");
  }

  /**
   * Hide a reply to a tweet
   */
  async hideReply(tweetId: string): Promise<{ hidden: boolean }> {
    return this.withTokenRefresh(async () => {
      await this.client.posts.hideReply(tweetId, { hidden: true });
      return { hidden: true };
    }, "posts.hideReply");
  }

  /**
   * Unhide a reply to a tweet
   */
  async unhideReply(tweetId: string): Promise<{ hidden: boolean }> {
    return this.withTokenRefresh(async () => {
      await this.client.posts.hideReply(tweetId, { hidden: false });
      return { hidden: false };
    }, "posts.hideReply");
  }

  /**
   * Get users who liked a tweet
   */
  async getLikingUsers(
    tweetId: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      username: string;
      name: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.getLikingUsers(tweetId, {
        maxResults,
        userFields: ["username", "name"],
      });
      return (result.data ?? []).map((user: any) => ({
        id: user.id,
        username: user.username ?? "",
        name: user.name ?? "",
      }));
    }, "posts.getLikingUsers");
  }

  /**
   * Get users who reposted a tweet
   */
  async getReposts(
    tweetId: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      username: string;
      name: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.getReposts(tweetId, {
        maxResults,
        userFields: ["username", "name"],
      });
      return (result.data ?? []).map((user: any) => ({
        id: user.id,
        username: user.username ?? "",
        name: user.name ?? "",
      }));
    }, "posts.getReposts");
  }

  /**
   * Get quoted tweet
   */
  async getQuoted(
    tweetId: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      text: string;
      authorId: string;
      createdAt: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.getQuoted(tweetId, {
        maxResults,
        tweetFields: ["createdAt", "authorId"],
      });
      return (result.data ?? []).map((tweet: any) => ({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.authorId ?? tweet.author_id ?? "",
        createdAt: tweet.createdAt ?? tweet.created_at ?? "",
      }));
    }, "posts.getQuoted");
  }

  // ============ User Operations ============

  /**
   * Follow a user
   */
  async followUser(userId: string): Promise<{ following: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.followUser(this.userId, {
        targetUserId: userId,
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X followUser failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X followUser failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { following: true };
    }, "users.followUser");
  }

  /**
   * Unfollow a user
   */
  async unfollowUser(userId: string): Promise<{ following: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.unfollowUser(this.userId, userId);
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X unfollowUser failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X unfollowUser failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { following: false };
    }, "users.unfollowUser");
  }

  /**
   * Mute a user
   */
  async muteUser(userId: string): Promise<{ muting: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.muteUser(this.userId, {
        targetUserId: userId,
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X muteUser failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X muteUser failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { muting: true };
    }, "users.muteUser");
  }

  /**
   * Unmute a user
   */
  async unmuteUser(userId: string): Promise<{ muting: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.unmuteUser(this.userId, userId);
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X unmuteUser failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X unmuteUser failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { muting: false };
    }, "users.unmuteUser");
  }

  /**
   * Get followers of a user
   */
  async getFollowers(
    userId: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      username: string;
      name: string;
      followersCount?: number;
      followingCount?: number;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getFollowers(userId, {
        maxResults,
        userFields: ["username", "name", "publicMetrics"],
      });
      return (result.data ?? []).map((user: any) => ({
        id: user.id,
        username: user.username ?? "",
        name: user.name ?? "",
        followersCount:
          user.publicMetrics?.followersCount ??
          user.public_metrics?.followers_count,
        followingCount:
          user.publicMetrics?.followingCount ??
          user.public_metrics?.following_count,
      }));
    }, "users.getFollowers");
  }

  /**
   * Get users that a user is following
   */
  async getFollowing(
    userId: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      username: string;
      name: string;
      followersCount?: number;
      followingCount?: number;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getFollowing(userId, {
        maxResults,
        userFields: ["username", "name", "publicMetrics"],
      });
      return (result.data ?? []).map((user: any) => ({
        id: user.id,
        username: user.username ?? "",
        name: user.name ?? "",
        followersCount:
          user.publicMetrics?.followersCount ??
          user.public_metrics?.followers_count,
        followingCount:
          user.publicMetrics?.followingCount ??
          user.public_metrics?.following_count,
      }));
    }, "users.getFollowing");
  }

  /**
   * Search for users
   */
  async searchUsers(
    query: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      username: string;
      name: string;
      bio?: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.search(query, {
        maxResults,
        userFields: ["username", "name", "description"],
      });
      return (result.data ?? []).map((user: any) => ({
        id: user.id,
        username: user.username ?? "",
        name: user.name ?? "",
        bio: user.description,
      }));
    }, "users.search");
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<{
    id: string;
    username: string;
    name: string;
    bio?: string;
    followersCount: number;
    followingCount: number;
    tweetCount: number;
  }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getByUsername(username, {
        userFields: ["username", "name", "description", "publicMetrics"],
      });
      const user = result.data as any;
      if (!user) {
        throw new AppError("bad_request:bot", "User not found");
      }
      return {
        id: user.id,
        username: user.username ?? "",
        name: user.name ?? "",
        bio: user.description,
        followersCount:
          user.publicMetrics?.followersCount ??
          user.public_metrics?.followers_count ??
          0,
        followingCount:
          user.publicMetrics?.followingCount ??
          user.public_metrics?.following_count ??
          0,
        tweetCount:
          user.publicMetrics?.tweetCount ??
          user.public_metrics?.tweet_count ??
          0,
      };
    }, "users.getByUsername");
  }

  /**
   * Get mentions of the authenticated user
   */
  async getMentions(maxResults = 20): Promise<
    Array<{
      id: string;
      text: string;
      authorId: string;
      createdAt: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getMentions(this.userId, {
        maxResults,
        tweetFields: ["createdAt", "authorId"],
      });
      return (result.data ?? []).map((tweet: any) => ({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.authorId ?? tweet.author_id ?? "",
        createdAt: tweet.createdAt ?? tweet.created_at ?? "",
      }));
    }, "users.getMentions");
  }

  // ============ List Operations ============

  /**
   * Get a list by ID
   */
  async getList(listId: string): Promise<{
    id: string;
    name: string;
    description?: string;
    ownerId: string;
    memberCount?: number;
    followerCount?: number;
    isPrivate?: boolean;
  }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.lists.getById(listId, {
        listFields: ["ownerId", "memberCount", "followerCount", "isPrivate"],
      });
      const list = result.data as any;
      if (!list) {
        throw new AppError("bad_request:bot", "List not found");
      }
      return {
        id: list.id,
        name: list.name ?? "",
        description: list.description,
        ownerId: list.ownerId ?? list.owner_id ?? "",
        memberCount: list.memberCount ?? list.member_count,
        followerCount: list.followerCount ?? list.follower_count,
        isPrivate: list.isPrivate ?? list.is_private,
      };
    }, "lists.getById");
  }

  /**
   * Get lists owned by a user
   */
  async getOwnedLists(
    userId: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      name: string;
      description?: string;
      memberCount?: number;
      followerCount?: number;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getOwnedLists(userId, {
        maxResults,
        listFields: ["memberCount", "followerCount"],
      });
      return (result.data ?? []).map((list: any) => ({
        id: list.id,
        name: list.name ?? "",
        description: list.description,
        memberCount: list.memberCount ?? list.member_count,
        followerCount: list.followerCount ?? list.follower_count,
      }));
    }, "users.getOwnedLists");
  }

  /**
   * Follow a list
   */
  async followList(listId: string): Promise<{ following: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.followList(this.userId, {
        listId,
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X followList failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X followList failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { following: true };
    }, "users.followList");
  }

  /**
   * Unfollow a list
   */
  async unfollowList(listId: string): Promise<{ following: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.unfollowList(this.userId, listId);
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X unfollowList failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X unfollowList failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { following: false };
    }, "users.unfollowList");
  }

  /**
   * Pin a list
   */
  async pinList(listId: string): Promise<{ pinned: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.pinList(this.userId, {
        listId,
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X pinList failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X pinList failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { pinned: true };
    }, "users.pinList");
  }

  /**
   * Unpin a list
   */
  async unpinList(listId: string): Promise<{ pinned: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.unpinList(this.userId, listId);
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X unpinList failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X unpinList failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { pinned: false };
    }, "users.unpinList");
  }

  // ============ Space Operations ============

  /**
   * Get a space by ID
   */
  async getSpace(spaceId: string): Promise<{
    id: string;
    title?: string;
    state: string;
    hostId?: string;
    participantCount?: number;
    subscriberCount?: number;
  }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.spaces.getById(spaceId, {
        spaceFields: ["hostId", "participantCount", "subscriberCount"],
      });
      const space = result.data as any;
      if (!space) {
        throw new AppError("bad_request:bot", "Space not found");
      }
      return {
        id: space.id,
        title: space.title,
        state: space.state ?? "",
        hostId: space.hostId ?? space.host_id,
        participantCount: space.participantCount ?? space.participant_count,
        subscriberCount: space.subscriberCount ?? space.subscriber_count,
      };
    }, "spaces.getById");
  }

  /**
   * Get spaces by creator IDs
   */
  async getSpacesByCreator(
    creatorIds: string[],
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      title?: string;
      state: string;
      hostId?: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.spaces.getByCreatorIds(creatorIds, {
        maxResults,
        spaceFields: ["hostId"],
      });
      return (result.data ?? []).map((space: any) => ({
        id: space.id,
        title: space.title,
        state: space.state ?? "",
        hostId: space.hostId ?? space.host_id,
      }));
    }, "spaces.getByCreatorIds");
  }

  /**
   * Get tweets from a space
   */
  async getSpaceTweets(
    spaceId: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      text: string;
      authorId: string;
      createdAt: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.spaces.getPosts(spaceId, {
        maxResults,
        tweetFields: ["createdAt", "authorId"],
      });
      return (result.data ?? []).map((tweet: any) => ({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.authorId ?? tweet.author_id ?? "",
        createdAt: tweet.createdAt ?? tweet.created_at ?? "",
      }));
    }, "spaces.getPosts");
  }

  // ============ Community Operations ============

  /**
   * Get a community by ID
   */
  async getCommunity(communityId: string): Promise<{
    id: string;
    name: string;
    description?: string;
    memberCount?: number;
    isPrivate?: boolean;
  }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.communities.getById(communityId, {
        communityFields: ["memberCount", "isPrivate"],
      });
      const community = result.data as any;
      if (!community) {
        throw new AppError("bad_request:bot", "Community not found");
      }
      return {
        id: community.id,
        name: community.name ?? "",
        description: community.description,
        memberCount: community.memberCount ?? community.member_count,
        isPrivate: community.isPrivate ?? community.is_private,
      };
    }, "communities.getById");
  }

  // ============ Trends Operations ============

  /**
   * Get trends by WOEID (Where On Earth ID)
   */
  async getTrends(woeid = 1): Promise<
    Array<{
      name: string;
      url?: string;
      promotedContent?: string;
      query: string;
      tweetVolume?: number;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.trends.getByWoeid(woeid);
      return (result.data ?? []).map((trend: any) => ({
        name: trend.name ?? "",
        url: trend.url,
        promotedContent: trend.promotedContent,
        query: trend.query ?? "",
        tweetVolume: trend.tweetVolume ?? trend.tweet_volume,
      }));
    }, "trends.getByWoeid");
  }

  // ============ Bookmark Operations ============

  /**
   * Get user's bookmarks
   */
  async getBookmarks(maxResults = 20): Promise<
    Array<{
      id: string;
      text: string;
      authorId: string;
      createdAt: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getBookmarks(this.userId, {
        maxResults,
        tweetFields: ["createdAt", "authorId"],
      });
      return (result.data ?? []).map((tweet: any) => ({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.authorId ?? tweet.author_id ?? "",
        createdAt: tweet.createdAt ?? tweet.created_at ?? "",
      }));
    }, "users.getBookmarks");
  }

  /**
   * Create a bookmark
   */
  async createBookmark(tweetId: string): Promise<{ bookmarked: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.createBookmark(this.userId, {
        tweetId,
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X createBookmark failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X createBookmark failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { bookmarked: true };
    }, "users.createBookmark");
  }

  /**
   * Delete a bookmark
   */
  async deleteBookmark(tweetId: string): Promise<{ bookmarked: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.deleteBookmark(
        this.userId,
        tweetId,
      );
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X deleteBookmark failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X deleteBookmark failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { bookmarked: false };
    }, "users.deleteBookmark");
  }

  /**
   * Get user's timeline (recent tweets)
   */
  async getTimeline(maxResults = 20): Promise<
    Array<{
      id: string;
      text: string;
      authorId: string;
      createdAt: string;
    }>
  > {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getTimeline(this.userId, {
        maxResults,
        tweetFields: ["createdAt", "authorId"],
      });
      return (result.data ?? []).map((tweet: any) => ({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.authorId ?? tweet.author_id ?? "",
        createdAt: tweet.createdAt ?? tweet.created_at ?? "",
      }));
    }, "users.getTimeline");
  }

  /**
   * Search tweets by query
   */
  async searchTweets(
    query: string,
    maxResults = 20,
  ): Promise<
    Array<{
      id: string;
      text: string;
      authorId: string;
      createdAt: string;
      likeCount?: number;
      retweetCount?: number;
      impressionCount?: number;
    }>
  > {
    // Twitter API requires max_results between 10 and 100
    const clampedMaxResults = Math.max(10, Math.min(100, maxResults));
    const token = await this.ensureAccessToken();
    const response = await this.client.httpClient.get(
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${clampedMaxResults}&tweet.fields=created_at,author_id,public_metrics`,
      { Authorization: `Bearer ${token}` },
    );
    if (!response.ok) {
      const text = await response.text();
      console.error(`[Bot ${this.botId}] X searchTweets failed: ${text}`);
      throw new AppError(
        "bad_request:bot",
        `X searchTweets failed (${response.status})`,
      );
    }
    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        text: string;
        author_id: string;
        created_at: string;
        public_metrics?: {
          retweet_count?: number;
          reply_count?: number;
          like_count?: number;
          quote_count?: number;
          impression_count?: number;
        };
      }>;
    };
    return (data.data ?? []).map((tweet) => ({
      id: tweet.id,
      text: tweet.text,
      authorId: tweet.author_id,
      createdAt: tweet.created_at,
      likeCount: tweet.public_metrics?.like_count,
      retweetCount: tweet.public_metrics?.retweet_count,
      impressionCount: tweet.public_metrics?.impression_count,
    }));
  }

  /**
   * Get user's notifications
   */
  async getNotifications(maxResults = 20): Promise<
    Array<{
      id: string;
      type: string;
      text: string;
      createdAt: string;
    }>
  > {
    const token = await this.ensureAccessToken();
    const response = await this.client.httpClient.get(
      `https://api.twitter.com/2/users/${this.userId}/notifications?max_results=${maxResults}`,
      { Authorization: `Bearer ${token}` },
    );
    if (!response.ok) {
      const text = await response.text();
      console.error(`[Bot ${this.botId}] X getNotifications failed: ${text}`);
      throw new AppError(
        "bad_request:bot",
        `X getNotifications failed (${response.status})`,
      );
    }
    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        type: string;
        message?: { text: string };
        created_at: string;
      }>;
    };
    return (data.data ?? []).map((notif) => ({
      id: notif.id,
      type: notif.type,
      text: notif.message?.text ?? "",
      createdAt: notif.created_at,
    }));
  }

  /**
   * Reply to a tweet
   */
  async replyTo(
    tweetId: string,
    text: string,
  ): Promise<{ id: string; text: string }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.posts.create({
        text,
        reply: { inReplyToTweetId: tweetId },
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X replyTo failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X replyTo failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      const data = result.data as { id: string; text: string } | undefined;
      if (!data) {
        throw new AppError("bad_request:bot", "X replyTo returned no data");
      }
      return data;
    }, "posts.create (reply)");
  }

  /**
   * Retweet a tweet
   */
  async retweet(tweetId: string): Promise<{ retweeted: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.repostPost(this.userId, {
        body: { tweetId },
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X retweet failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X retweet failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { retweeted: true };
    }, "users.repostPost");
  }

  /**
   * Like a tweet
   */
  async likeTweet(tweetId: string): Promise<{ liked: boolean }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.likePost(this.userId, {
        body: { tweetId },
      });
      if (result.errors?.length) {
        const err = result.errors[0];
        console.error(
          `[Bot ${this.botId}] X likeTweet failed: ${JSON.stringify(err)}`,
        );
        throw new AppError(
          "bad_request:bot",
          `X likeTweet failed: ${err.detail ?? JSON.stringify(err)}`,
        );
      }
      return { liked: true };
    }, "users.likePost");
  }

  /**
   * Get user profile
   */
  async getProfile(): Promise<{
    id: string;
    username: string;
    name: string;
    bio?: string;
    followersCount: number;
    followingCount: number;
    tweetCount: number;
  }> {
    return this.withTokenRefresh(async () => {
      const result = await this.client.users.getById(this.userId, {
        userFields: ["publicMetrics", "description"],
      });
      const user = result.data as any;
      if (!user) {
        throw new AppError("bad_request:bot", "X getProfile returned no data");
      }
      return {
        id: user.id,
        username: user.username ?? "",
        name: user.name ?? "",
        bio: user.description,
        followersCount:
          user.publicMetrics?.followersCount ??
          user.public_metrics?.followers_count ??
          0,
        followingCount:
          user.publicMetrics?.followingCount ??
          user.public_metrics?.following_count ??
          0,
        tweetCount:
          user.publicMetrics?.tweetCount ??
          user.public_metrics?.tweet_count ??
          0,
      };
    }, "users.getById");
  }
}
