import type * as React from "react";

type AppLinkProps = Omit<React.ComponentProps<"a">, "href"> & { href: string; replace?: boolean };

/** A link to a screen of this app (`/settings`) or, with a scheme, somewhere else. */
export function AppLink({ href, replace, onClick, ...props }: AppLinkProps) {
  const inApp = href.startsWith("/");
  return (
    <a
      {...props}
      href={inApp ? `#${href}` : href}
      onClick={(event) => {
        onClick?.(event);
        if (!inApp || !replace || event.defaultPrevented) return;
        event.preventDefault();
        location.replace(`#${href}`);
      }}
    />
  );
}
