import * as React from "react";

type AppLinkProps = Omit<React.ComponentProps<"a">, "href"> & { href: string; replace?: boolean };

export const EmbeddedNavContext = React.createContext<((href: string) => boolean) | null>(null);

/** A link to a screen of this app (`/settings`) or, with a scheme, somewhere else. */
export function AppLink({ href, replace, onClick, ...props }: AppLinkProps) {
  const inApp = href.startsWith("/");
  const intercept = React.useContext(EmbeddedNavContext);
  return (
    <a
      {...props}
      href={inApp ? `#${href}` : href}
      onClick={(event) => {
        onClick?.(event);
        if (!inApp || event.defaultPrevented) return;
        if (intercept?.(href)) {
          event.preventDefault();
          return;
        }
        if (!replace) return;
        event.preventDefault();
        location.replace(`#${href}`);
      }}
    />
  );
}
