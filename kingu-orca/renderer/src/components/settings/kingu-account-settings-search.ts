import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getKinguAccountSettingsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.kinguAccount.account', 'Kingu account'),
    description: translate(
      'auto.components.settings.kinguAccount.searchDescription',
      'Sign in or out of the account used by Artifacts and Kingu Relay.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.kinguAccount.keywordAccount', 'account'),
      ...translateSearchKeyword('auto.components.settings.kinguAccount.keywordLogin', 'login'),
      ...translateSearchKeyword('auto.components.settings.kinguAccount.keywordLogout', 'logout'),
      ...translateSearchKeyword('auto.components.settings.kinguAccount.keywordSignIn', 'sign in'),
      ...translateSearchKeyword('auto.components.settings.kinguAccount.keywordSignOut', 'sign out'),
      ...translateSearchKeyword('auto.components.settings.kinguAccount.keywordRelay', 'relay'),
      ...translateSearchKeyword('auto.components.settings.kinguAccount.keywordCloud', 'cloud')
    ]
  }
])
