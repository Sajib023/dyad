import { ipc } from "@/ipc/types";
import {
  X,
  ExternalLink as ExternalLinkIcon,
  CircleArrowUp,
  MessageSquarePlus,
  ArrowRight,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

export function ChatErrorBox({
  onDismiss,
  error,
  onStartNewChat,
  onSwitchToBuildMode,
}: {
  onDismiss: () => void;
  error: string;
  onStartNewChat?: () => void;
  onSwitchToBuildMode?: () => void;
}) {
  // This is a very long list of model fallbacks that clutters the error message.
  //
  // We are matching "Fallbacks=[{" and not just "Fallbacks=" because the fallback
  // model itself can error and we want to include the fallback model error in the error message.
  // Example: https://github.com/dyad-sh/dyad/issues/1849#issuecomment-3590685911
  const fallbackPrefix = "Fallbacks=[{";
  if (error.includes(fallbackPrefix)) {
    error = error.split(fallbackPrefix)[0];
  }

  return (
    <ChatErrorContainer onDismiss={onDismiss}>
      <div className="max-h-64 overflow-y-auto scrollbar-on-hover">
        <ErrorMarkdown>{error}</ErrorMarkdown>
      </div>
      <div className="mt-2 space-y-2 space-x-2">
        {onSwitchToBuildMode && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSwitchToBuildMode}
            className="gap-1.5"
          >
            Switch to Build
            <ArrowRight size={16} />
          </Button>
        )}
        {onStartNewChat && (
          <Tooltip>
            <TooltipTrigger
              onClick={onStartNewChat}
              className="cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500"
            >
              <span>Start new chat</span>
              <MessageSquarePlus size={18} />
            </TooltipTrigger>
            <TooltipContent>
              Starting a new chat can fix some issues
            </TooltipContent>
          </Tooltip>
        )}
        <ExternalLink href="https://www.dyad.sh/docs/faq">
          Read docs
        </ExternalLink>
      </div>
    </ChatErrorContainer>
  );
}

function ExternalLink({
  href,
  children,
  variant = "secondary",
  icon,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  icon?: React.ReactNode;
}) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const primaryClasses =
    "bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500";
  const secondaryClasses =
    "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 focus:ring-blue-200";
  const iconElement =
    icon ??
    (variant === "primary" ? (
      <CircleArrowUp size={18} />
    ) : (
      <ExternalLinkIcon size={14} />
    ));

  return (
    <a
      className={`${baseClasses} ${variant === "primary" ? primaryClasses : secondaryClasses}`}
      onClick={() => ipc.system.openExternalUrl(href)}
    >
      <span>{children}</span>
      {iconElement}
    </a>
  );
}

function ChatErrorContainer({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: React.ReactNode | string;
}) {
  return (
    <div
      data-testid="chat-error-box"
      className="relative mt-2 bg-red-50 border border-red-200 rounded-md shadow-sm p-2 mx-4"
    >
      <button
        onClick={onDismiss}
        className="absolute top-2.5 left-2 p-1 hover:bg-red-100 rounded"
      >
        <X size={14} className="text-red-500" />
      </button>
      <div className="pl-8 py-1 text-sm">
        <div className="text-red-700 text-wrap">
          {typeof children === "string" ? (
            <ErrorMarkdown>{children}</ErrorMarkdown>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: linkChildren, ...props }) => (
          <a
            {...props}
            onClick={(e) => {
              e.preventDefault();
              if (props.href) {
                ipc.system.openExternalUrl(props.href);
              }
            }}
            className="text-blue-500 hover:text-blue-700"
          >
            {linkChildren}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
