import { useEffect, useState } from 'react';
import { Film, LayoutGrid, List, Search, Star } from 'lucide-react';
import { PageHeader } from '../components/Layout';
import { ClipCard, ClipRow } from '../components/ClipCard';
import { Button, EmptyState, Segmented, Select, Spinner, TextInput } from '../components/ui';
import type { ClipSort } from '../lib/ipc';
import { useLibrary } from '../stores/library';

const SORTS: { value: ClipSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'longest', label: 'Longest' },
  { value: 'largest', label: 'Largest' },
  { value: 'title', label: 'Title A–Z' },
];

export function Library() {
  const { clips, games, query, setQuery, view, setView, loading } = useLibrary();
  const [search, setSearch] = useState(query.search ?? '');

  useEffect(() => {
    const t = setTimeout(() => {
      if ((query.search ?? '') !== search) setQuery({ search });
    }, 200);
    return () => clearTimeout(t);
  }, [search, query.search, setQuery]);

  const filtered = !!(query.search || query.game || query.favoritesOnly);

  return (
    <>
      <PageHeader
        title="Library"
        subtitle={`${clips.length} clip${clips.length === 1 ? '' : 's'} stored on this PC`}
        actions={
          <Segmented
            label="Layout"
            value={view}
            onChange={setView}
            options={[
              { value: 'grid', label: <LayoutGrid className="size-3.5" />, title: 'Grid' },
              { value: 'list', label: <List className="size-3.5" />, title: 'List' },
            ]}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-8 pt-5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" />
          <TextInput
            aria-label="Search clips"
            placeholder="Search titles and games"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72 pl-8"
          />
        </div>
        <Select
          label="Filter by game"
          value={query.game ?? ''}
          onChange={(v) => setQuery({ game: v || null })}
          className="w-52"
          options={[{ value: '', label: 'All games' }, ...games.map((g) => ({ value: g, label: g }))]}
        />
        <Select label="Sort" value={query.sort ?? 'newest'} onChange={(v) => setQuery({ sort: v })} className="w-40" options={SORTS} />
        <Button
          variant={query.favoritesOnly ? 'primary' : 'secondary'}
          icon={<Star className={query.favoritesOnly ? 'size-4 fill-current' : 'size-4'} />}
          onClick={() => setQuery({ favoritesOnly: !query.favoritesOnly })}
        >
          Favorites
        </Button>
        {loading && <Spinner className="ml-2" />}
      </div>

      <div className="px-8 py-5">
        {clips.length === 0 ? (
          <EmptyState
            icon={<Film className="size-5" />}
            title={filtered ? 'No matching clips' : 'Your library is empty'}
            body={
              filtered
                ? 'Try a different search or clear the filters.'
                : 'Saved replays, recordings and edits appear here. They stay on this PC even without an account.'
            }
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    setSearch('');
                    setQuery({ search: null, game: null, favoritesOnly: false });
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : view === 'grid' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {clips.map((c) => (
              <ClipCard key={c.id} clip={c} />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="grid grid-cols-[112px_minmax(0,1fr)_140px_90px_80px_90px_110px] gap-4 border-b border-line px-4 py-2 text-xs font-medium text-fg-subtle">
              <span />
              <span>Title</span>
              <span>Game</span>
              <span>Duration</span>
              <span>Quality</span>
              <span>Size</span>
              <span>Cloud</span>
            </div>
            {clips.map((c) => (
              <ClipRow key={c.id} clip={c} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
