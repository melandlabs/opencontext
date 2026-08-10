import type { TFunction } from "i18next";
import type { IntegrationId } from "@opencontext/contracts/integration-id";

export interface PlatformDisplayInfo {
  icon: string;
  label: string;
  iconBackground: string;
}

export interface PlatformConnectCardTheme {
  cardBackground: string;
  buttonBackground: string;
  buttonText: string;
}

const PLATFORM_LOGOS: Partial<Record<IntegrationId, string>> = {
  slack: "/images/apps/slack.png",
  telegram: "/images/apps/telegram.png",
  discord: "/images/apps/discord.png",
  whatsapp: "/images/apps/whatsapp.png",
  gmail: "/images/apps/gmail.png",
  outlook: "/images/apps/outlook.png",
  imessage: "/images/apps/iMessage.png",
  hubspot: "/images/apps/hubspot.png",
  asana: "/images/apps/asana.png",
  jira: "/images/apps/jira.png",
  linear: "/images/apps/linear.png",
  google_docs: "/images/apps/google_docs.png",
  google_drive: "/images/apps/google_drive.png",
  google_calendar: "/images/apps/google_calendar.png",
  linkedin: "/images/apps/linkedin.png",
  facebook_messenger: "/images/apps/facebook_messenger.png",
  teams: "/images/apps/teams.png",
  notion: "/images/apps/notion.png",
  github: "/images/apps/github.png",
  twitter: "/images/apps/twitter.png",
  instagram: "/images/apps/instagram.png",
  outlook_calendar: "/images/apps/outlook_calendar.png",
  feishu: "/images/apps/feishu.png",
  dingtalk: "/images/apps/DingTalk.png",
  qqbot: "/images/apps/qq.png",
  weixin: "/images/apps/WeChat.png",
};

const PLATFORM_DISPLAY_INFO: Record<
  IntegrationId,
  Omit<PlatformDisplayInfo, "label"> & { label: string }
> = {
  slack: {
    icon: "slack",
    label: "Slack",
    iconBackground: "bg-[#4A154B]/10 text-[#4A154B]",
  },
  telegram: {
    icon: "send_plane",
    label: "Telegram",
    iconBackground: "bg-[#0088CC]/10 text-[#0088CC]",
  },
  discord: {
    icon: "hashtag",
    label: "Discord",
    iconBackground: "bg-[#5865F2]/10 text-[#5865F2]",
  },
  twitter: {
    icon: "twitter-x",
    label: "X (Twitter)",
    iconBackground: "bg-black/10 text-black",
  },
  gmail: {
    icon: "mail",
    label: "Gmail",
    iconBackground: "bg-red-500/10 text-red-500",
  },
  teams: {
    icon: "panel_left",
    label: "Microsoft Teams",
    iconBackground: "bg-[#6264A7]/10 text-[#6264A7]",
  },
  whatsapp: {
    icon: "message",
    label: "WhatsApp",
    iconBackground: "bg-[#25D366]/10 text-[#25D366]",
  },
  outlook: {
    icon: "mail",
    label: "Outlook",
    iconBackground: "bg-[#0F7BFF]/10 text-[#0F7BFF]",
  },
  linkedin: {
    icon: "linkedin",
    label: "LinkedIn",
    iconBackground: "bg-[#0A66C2]/10 text-[#0A66C2]",
  },
  facebook_messenger: {
    icon: "message",
    label: "Facebook Messenger",
    iconBackground: "bg-[#0084FF]/10 text-[#0084FF]",
  },
  google_drive: {
    icon: "cloud",
    label: "Google Drive",
    iconBackground: "bg-[#1A73E8]/10 text-[#1A73E8]",
  },
  google_docs: {
    icon: "file_text",
    label: "Google Docs",
    iconBackground: "bg-[#1A73E8]/10 text-[#1A73E8]",
  },
  outlook_calendar: {
    icon: "calendar",
    label: "Outlook Calendar",
    iconBackground: "bg-[#0F7BFF]/10 text-[#0F7BFF]",
  },
  hubspot: {
    icon: "orbit",
    label: "HubSpot",
    iconBackground: "bg-[#FF7A59]/10 text-[#FF7A59]",
  },
  notion: {
    icon: "blocks",
    label: "Notion",
    iconBackground: "bg-neutral-900/10 text-neutral-900",
  },
  github: {
    icon: "github",
    label: "GitHub",
    iconBackground: "bg-neutral-900/10 text-neutral-900",
  },
  google_calendar: {
    icon: "calendar",
    label: "Google Calendar",
    iconBackground: "bg-[#1A73E8]/10 text-[#1A73E8]",
  },
  google_meet: {
    icon: "video",
    label: "Google Meet",
    iconBackground: "bg-[#0F9D58]/10 text-[#0F9D58]",
  },
  instagram: {
    icon: "instagram",
    label: "Instagram",
    iconBackground:
      "bg-gradient-to-r from-[#F58529]/20 via-[#DD2A7B]/20 to-[#8134AF]/20 text-[#DD2A7B]",
  },
  asana: {
    icon: "circle_check",
    label: "Asana",
    iconBackground: "bg-[#06B7D2]/10 text-[#06B7D2]",
  },
  jira: {
    icon: "ticket",
    label: "Jira",
    iconBackground: "bg-[#0052CC]/10 text-[#0052CC]",
  },
  linear: {
    icon: "zap",
    label: "Linear",
    iconBackground: "bg-[#5E6AD2]/10 text-[#5E6AD2]",
  },
  imessage: {
    icon: "apple",
    label: "iMessage",
    iconBackground: "bg-[#007AFF]/10 text-[#007AFF]",
  },
  feishu: {
    icon: "chat-smile",
    label: "Lark/Feishu",
    iconBackground: "bg-[#3370FF]/10 text-[#3370FF]",
  },
  dingtalk: {
    icon: "chat-smile",
    label: "DingTalk",
    iconBackground: "bg-[#0089FF]/10 text-[#0089FF]",
  },
  qqbot: {
    icon: "qq",
    label: "QQ",
    iconBackground: "bg-[#12B7F5]/10 text-[#12B7F5]",
  },
  weixin: {
    icon: "chat-smile",
    label: "Weixin",
    iconBackground: "bg-[#07C160]/10 text-[#07C160]",
  },
};

const PLATFORM_CONNECT_CARD_THEMES: Record<
  IntegrationId,
  PlatformConnectCardTheme
> = {
  discord: {
    cardBackground: "#EEF0FF",
    buttonBackground: "#5865F2",
    buttonText: "#FFFFFF",
  },
  slack: {
    cardBackground: "#F8EAF8",
    buttonBackground: "#4A154B",
    buttonText: "#FFFFFF",
  },
  gmail: {
    cardBackground: "#EDEEF3",
    buttonBackground: "#000000",
    buttonText: "#FFFFFF",
  },
  imessage: {
    cardBackground: "#E6FBE9",
    buttonBackground: "#05C334",
    buttonText: "#FFFFFF",
  },
  dingtalk: {
    cardBackground: "#E5F3FF",
    buttonBackground: "#2F9DFF",
    buttonText: "#FFFFFF",
  },
  weixin: {
    cardBackground: "#E4FBE8",
    buttonBackground: "#14C900",
    buttonText: "#FFFFFF",
  },
  hubspot: {
    cardBackground: "#FDEDEA",
    buttonBackground: "#FF5638",
    buttonText: "#FFFFFF",
  },
  google_meet: {
    cardBackground: "#E8F5EE",
    buttonBackground: "#0F9D58",
    buttonText: "#FFFFFF",
  },
  notion: {
    cardBackground: "#EFEFF4",
    buttonBackground: "#000000",
    buttonText: "#FFFFFF",
  },
  telegram: {
    cardBackground: "#E5F5FC",
    buttonBackground: "#29A9E1",
    buttonText: "#FFFFFF",
  },
  whatsapp: {
    cardBackground: "#E6FBE9",
    buttonBackground: "#05C334",
    buttonText: "#FFFFFF",
  },
  outlook: {
    cardBackground: "#E5F3FF",
    buttonBackground: "#0A6EC7",
    buttonText: "#FFFFFF",
  },
  feishu: {
    cardBackground: "#E5F1FF",
    buttonBackground: "#0B74FF",
    buttonText: "#FFFFFF",
  },
  qqbot: {
    cardBackground: "#E5F3FF",
    buttonBackground: "#2F9DFF",
    buttonText: "#FFFFFF",
  },
  twitter: {
    cardBackground: "#EFEFF4",
    buttonBackground: "#000000",
    buttonText: "#FFFFFF",
  },
  linkedin: {
    cardBackground: "#E5F3FF",
    buttonBackground: "#0A66C2",
    buttonText: "#FFFFFF",
  },
  google_drive: {
    cardBackground: "#E8F1FE",
    buttonBackground: "#1A73E8",
    buttonText: "#FFFFFF",
  },
  google_docs: {
    cardBackground: "#E8F1FE",
    buttonBackground: "#1A73E8",
    buttonText: "#FFFFFF",
  },
  google_calendar: {
    cardBackground: "#E8F1FE",
    buttonBackground: "#1A73E8",
    buttonText: "#FFFFFF",
  },
  outlook_calendar: {
    cardBackground: "#E5F3FF",
    buttonBackground: "#0F7BFF",
    buttonText: "#FFFFFF",
  },
  teams: {
    cardBackground: "#EEEEFA",
    buttonBackground: "#6264A7",
    buttonText: "#FFFFFF",
  },
  facebook_messenger: {
    cardBackground: "#E5F3FF",
    buttonBackground: "#0084FF",
    buttonText: "#FFFFFF",
  },
  github: {
    cardBackground: "#EFEFF4",
    buttonBackground: "#000000",
    buttonText: "#FFFFFF",
  },
  instagram: {
    cardBackground: "#FCEAF3",
    buttonBackground: "#DD2A7B",
    buttonText: "#FFFFFF",
  },
  asana: {
    cardBackground: "#E6F8FB",
    buttonBackground: "#06B7D2",
    buttonText: "#FFFFFF",
  },
  jira: {
    cardBackground: "#E8F1FF",
    buttonBackground: "#0052CC",
    buttonText: "#FFFFFF",
  },
  linear: {
    cardBackground: "#EEEEFB",
    buttonBackground: "#5E6AD2",
    buttonText: "#FFFFFF",
  },
};

export function resolvePlatformLogo(platformId: IntegrationId): string | null {
  return PLATFORM_LOGOS[platformId] ?? null;
}

export function getPlatformDisplayInfo(
  platformId: IntegrationId,
  t?: TFunction,
): PlatformDisplayInfo {
  const info = PLATFORM_DISPLAY_INFO[platformId];
  if (!info) {
    return {
      icon: "ticket",
      label: platformId.charAt(0).toUpperCase() + platformId.slice(1),
      iconBackground: "bg-gray-500/10 text-gray-500",
    };
  }

  return {
    ...info,
    label:
      platformId === "weixin"
        ? (t?.("platform.weixin") ?? info.label)
        : info.label,
  };
}

export function getPlatformConnectCardTheme(
  platformId: IntegrationId,
): PlatformConnectCardTheme {
  return (
    PLATFORM_CONNECT_CARD_THEMES[platformId] ?? {
      cardBackground: "#EFEFF4",
      buttonBackground: "#000000",
      buttonText: "#FFFFFF",
    }
  );
}
