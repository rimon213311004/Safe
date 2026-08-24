'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { roleAtLeast, useRequireAuth } from '@/lib/auth';
import { Loading } from '@/components/ui';

/**
 * Chrome for every authenticated screen.
 *
 * The whole authenticated area is client-rendered. That is not a preference: the
 * access token is held in memory only (see lib/api.ts), so a server render has no
 * credential to fetch with and would produce an empty shell anyway. Rendering on
 * the client keeps the data-loading story in one place.
 *
 * Below 860px the sidebar becomes an off-canvas drawer behind the app bar. The
 * unread count moves into the app bar rather than being hidden with the rest of
 * the navigation — it is the one thing on this frame that changes without the
 * user doing anything, so burying it behind a tap would make it useless.
 */

interface NavItem {
  href: string;
  label: string;
  /**
   * Every item carries one. A rail of six text labels gives the eye nothing to
   * land on, and after a day of use people navigate by shape rather than by
   * reading — which only works if the shapes differ.
   */
  Icon: () => React.JSX.Element;
  /** Extra path prefixes that should also light this item up. */
  match?: string[];
}

const PERSONAL: NavItem[] = [
  { href: '/search', label: 'Check an identifier', Icon: SearchIcon },
  { href: '/reports', label: 'My reports', Icon: FileIcon },
  { href: '/notifications', label: 'Notifications', Icon: BellIcon },
  { href: '/settings', label: 'Account', Icon: UserIcon },
];

const MODERATION: NavItem[] = [
  { href: '/moderation', label: 'Case queue', Icon: QueueIcon, match: ['/moderation/cases'] },
  { href: '/moderation/appeals', label: 'Appeals', Icon: ScalesIcon },
];

function isCurrent(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  if (item.match?.some((prefix) => pathname.startsWith(prefix))) return true;
  // `/moderation` must not claim `/moderation/appeals`; only listed prefixes do.
  return item.href !== '/' && item.href !== '/moderation' && pathname.startsWith(`${item.href}/`);
}

/** First letters of the first two words — "Ada Lovelace" → "AL". */
function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('');
  return letters.toUpperCase() || '?';
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, status, signOut } = useRequireAuth();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Re-read the badge on navigation rather than on a timer: the count only
  // changes as a result of something the user or a moderator just did, and a poll
  // would put a request on the wire every few seconds for the whole session.
  useEffect(() => {
    if (status !== 'authenticated') return;
    let live = true;
    void api
      .listNotifications({ limit: 1 })
      .then((page) => {
        if (live) setUnread(page.unread);
      })
      .catch(() => {
        // A failed badge fetch is not worth a visible error.
      });
    return () => {
      live = false;
    };
  }, [status, pathname]);

  // Arriving somewhere new closes the drawer. No focus move here — the router
  // is already relocating focus for the new page.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Closing hands focus back to the button that opened it. The drawer goes
  // `visibility: hidden`, which would otherwise drop focus to the document body.
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }, []);

  // While the drawer is open: lock the page behind it, and let Escape out.
  useEffect(() => {
    if (!menuOpen) return;
    document.body.classList.add('nav-open');
    // Focused directly rather than on a later frame. This works only because the
    // drawer's `visibility` flips with the class instead of being transitioned
    // (see globals.css) — focus() on an element computing as hidden is dropped.
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('nav-open');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen, closeMenu]);

  if (status === 'loading') return <Loading label="Restoring your session…" />;
  // The hook is already navigating away; rendering the shell would flash it.
  if (status === 'anonymous' || !user) return null;

  const isModerator = roleAtLeast(user.role, 'moderator');
  const unreadLabel = unread > 99 ? '99+' : String(unread);

  const navLink = (item: NavItem) => (
    <Link
      key={item.href}
      href={item.href}
      aria-current={isCurrent(pathname, item) ? 'page' : undefined}
      onClick={closeMenu}
    >
      <span className="nav-icon" aria-hidden="true">
        <item.Icon />
      </span>
      <span className="nav-label">{item.label}</span>
      {item.href === '/notifications' && unread > 0 ? (
        <span className="pill" aria-label={`${unread} unread`}>
          {unreadLabel}
        </span>
      ) : null}
    </Link>
  );

  return (
    <div className="shell">
      <header className="appbar">
        <button
          ref={triggerRef}
          type="button"
          className="icon-btn"
          aria-label="Main menu"
          aria-expanded={menuOpen}
          aria-controls="app-nav"
          onClick={() => setMenuOpen(true)}
        >
          <MenuIcon />
        </button>

        <Link href="/" className="brand">
          <span className="mark" aria-hidden="true">
            SC
          </span>
          SafeCheck
        </Link>

        <span className="spacer" />

        <Link
          href="/notifications"
          className="icon-btn"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <BellIcon />
          {unread > 0 ? (
            <span className="pill" aria-hidden="true">
              {unreadLabel}
            </span>
          ) : null}
        </Link>
      </header>

      {menuOpen ? (
        <button type="button" className="scrim" aria-label="Close menu" onClick={closeMenu} />
      ) : null}

      <aside id="app-nav" className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="nav-head">
          <Link href="/" className="brand" onClick={closeMenu}>
            <span className="mark" aria-hidden="true">
              SC
            </span>
            SafeCheck
          </Link>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn drawer-only"
            aria-label="Close menu"
            onClick={closeMenu}
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="nav" aria-label="Main">
          {PERSONAL.map(navLink)}

          {isModerator ? (
            <div className="nav-section">
              <span className="nav-heading">Moderation</span>
              <div className="nav">{MODERATION.map(navLink)}</div>
            </div>
          ) : null}
        </nav>

        <div className="spacer" />

        <div className="stack tight">
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {initialsOf(user.name)}
            </span>
            <span className="account-id">
              <span className="account-name">{user.name}</span>
              <span className="account-role">{user.role}</span>
            </span>
          </div>
          <button type="button" className="btn ghost small" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="container wide">{children}</div>
      </main>
    </div>
  );
}

/* Icons. A handful of 20px line glyphs, so they live here rather than in a
   dependency — an icon package would be a megabyte for nine paths. */

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function MenuIcon() {
  return <Glyph>{<path d="M3 5.5h14M3 10h14M3 14.5h14" />}</Glyph>;
}

function CloseIcon() {
  return <Glyph>{<path d="M5 5l10 10M15 5L5 15" />}</Glyph>;
}

function BellIcon() {
  return (
    <Glyph>
      <path d="M10 3.2A3.8 3.8 0 0 0 6.2 7v2.9L4.8 13h10.4l-1.4-3.1V7A3.8 3.8 0 0 0 10 3.2Z" />
      <path d="M8.3 15.2a1.8 1.8 0 0 0 3.4 0" />
    </Glyph>
  );
}

function SearchIcon() {
  return (
    <Glyph>
      <circle cx="8.8" cy="8.8" r="5.3" />
      <path d="M12.8 12.8 17 17" />
    </Glyph>
  );
}

function FileIcon() {
  return (
    <Glyph>
      <path d="M11.2 2.8H6.4a1.4 1.4 0 0 0-1.4 1.4v11.6a1.4 1.4 0 0 0 1.4 1.4h7.2a1.4 1.4 0 0 0 1.4-1.4V6.6l-3.8-3.8Z" />
      <path d="M11.2 2.8v3.8H15" />
      <path d="M7.6 11h4.8M7.6 13.8h3" />
    </Glyph>
  );
}

function UserIcon() {
  return (
    <Glyph>
      <circle cx="10" cy="7.2" r="3" />
      <path d="M4.6 16.6a5.6 5.6 0 0 1 10.8 0" />
    </Glyph>
  );
}

function QueueIcon() {
  return (
    <Glyph>
      <path d="M4.6 3.6h10.8l1.8 7.4v4.2a1.2 1.2 0 0 1-1.2 1.2H4a1.2 1.2 0 0 1-1.2-1.2V11l1.8-7.4Z" />
      <path d="M2.8 11h3.6l1 2h5.2l1-2h3.6" />
    </Glyph>
  );
}

function ScalesIcon() {
  return (
    <Glyph>
      <path d="M10 3.4v13.2M6.4 16.6h7.2M4.4 7.2h11.2" />
      <path d="M4.4 7.2 2.6 11.2h3.6L4.4 7.2Z" />
      <path d="M15.6 7.2 13.8 11.2h3.6l-1.8-4Z" />
    </Glyph>
  );
}
