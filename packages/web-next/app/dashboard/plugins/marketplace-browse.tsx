'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import { usePluginStore } from '@/stores/plugin-store';
import { PluginIcon, getLocale, translate } from './plugin-ui';

export default function MarketplaceBrowse({ defaultActorId: _defaultActorId }: { defaultActorId?: string }) {
  const router = useRouter();
  const { marketplace, categories, installations, loadMarketplace, loadCategories, loadingMarketplace } = usePluginStore();
  const [search, setSearch] = useState('');
  const [selectedCategorySlug, setSelectedCategorySlug] = useState<string | null>(null);
  const locale = getLocale();

  useEffect(() => {
    if (categories.length === 0) {
      void loadCategories();
    }
  }, [categories.length, loadCategories]);

  const handleSearch = () => {
    const filters = selectedCategorySlug ? [selectedCategorySlug] : [];
    void loadMarketplace(search || undefined, filters);
  };

  const installedCount = (pluginId: string) => {
    return installations.filter((installation: any) => installation.plugin_id === pluginId).length;
  };

  const openPlugin = (pluginId: string) => router.push(`/dashboard/plugins/${pluginId}`);

  const selectCategory = (slug: string | null) => {
    setSelectedCategorySlug(slug);
    void loadMarketplace(search || undefined, slug ? [slug] : []);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex min-w-max items-end gap-6 border-b border-gray-100 pb-px">
              <button
                type="button"
                onClick={() => selectCategory(null)}
                className={`relative pb-3 text-[15px] transition-colors ${
                  !selectedCategorySlug ? 'font-medium text-blue-600' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                全部插件
                {!selectedCategorySlug ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-blue-600" /> : null}
              </button>
              {categories.map((category: any) => {
                const active = selectedCategorySlug === category.slug;
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => selectCategory(category.slug)}
                    className={`relative whitespace-nowrap pb-3 text-[15px] transition-colors ${
                      active ? 'font-medium text-blue-600' : 'text-gray-500 hover:text-gray-900'
                    }`}
                  >
                    {translate(category.displayNameI18n, locale, category.defaultLocale || 'en') || category.displayName}
                    {active ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-blue-600" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="w-full xl:w-auto xl:min-w-[320px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <button
              type="button"
              onClick={handleSearch}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-blue-600 transition-colors hover:text-blue-700"
            >
              搜索
            </button>
            <Input
              placeholder="搜索插件"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleSearch()}
              className="h-11 rounded-full border-gray-200 bg-white pl-10 pr-16 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {loadingMarketplace ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading plugins...</div>
      ) : (
        <div
          className="grid gap-x-12"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}
        >
          {marketplace.map((plugin: any) => {
            const count = installedCount(plugin.id);
            const title = translate(plugin.display_name_i18n, locale, plugin.default_locale || 'en') || plugin.display_name;
            const summary = translate(plugin.summary_i18n || plugin.description_i18n, locale, plugin.default_locale || 'en') || plugin.description;
            const primaryCategory = plugin.categories?.[0];
            const primaryCategoryLabel = primaryCategory
              ? translate(primaryCategory.displayNameI18n, locale, primaryCategory.defaultLocale || 'en') || primaryCategory.displayName
              : '插件';

            return (
              <div
                key={plugin.id}
                className="-mx-4 flex cursor-pointer items-center rounded-2xl border-b border-gray-100 px-4 py-5 transition-colors hover:bg-gray-50/70"
                onClick={() => openPlugin(plugin.id)}
              >
                <PluginIcon
                  iconUrl={plugin.icon_url}
                  title={title}
                  transport={plugin.transport}
                  verified={plugin.is_builtin}
                />

                <div className="ml-4 min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <h3 className="truncate text-[15px] font-medium text-gray-900">{title}</h3>
                  </div>

                  <div className="mt-0.5 flex flex-col">
                    <span className="text-[12px] text-gray-500">
                      {primaryCategoryLabel}
                      {plugin.org_display_name ? ` · ${plugin.org_display_name}` : ''}
                    </span>
                    {summary ? (
                      <span className="mt-0.5 truncate text-[12px] text-gray-400">
                        {summary}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(plugin.categories || []).slice(1, 3).map((category: any) => (
                      <Badge key={category.slug} variant="secondary" className="bg-gray-50 text-[11px] text-gray-600">
                        {translate(category.displayNameI18n, locale, category.defaultLocale || 'en') || category.displayName}
                      </Badge>
                    ))}
                    {(plugin.tags || []).slice(0, 2).map((tag: string) => (
                      <Badge key={tag} variant="secondary" className="bg-gray-50 text-[11px] text-gray-500">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="ml-4 flex-shrink-0">
                  {count > 0 ? (
                    <Button
                      variant="ghost"
                      className="rounded-full bg-emerald-50 px-5 py-1.5 text-[13px] font-medium text-emerald-600 hover:bg-emerald-100 hover:text-emerald-700"
                      onClick={(event) => {
                        event.stopPropagation();
                        openPlugin(plugin.id);
                      }}
                    >
                      配置
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      className="rounded-full bg-[#f0f4ff] px-5 py-1.5 text-[13px] font-medium text-[#2563eb] hover:bg-[#e0e7ff] hover:text-[#1d4ed8]"
                      onClick={(event) => {
                        event.stopPropagation();
                        openPlugin(plugin.id);
                      }}
                    >
                      安装
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
