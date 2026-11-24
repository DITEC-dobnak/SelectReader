# Select Reader

Select Reader umožňuje na Windows prezerať diagramy, slovník a prepojenia modelu Select Architect a exportovať ich do Markdownu. Model na serveri nemení a nevyžaduje inštaláciu Select Architect ani COM.

## Začni tu

1. Na Windows x64 rozbaľ celý `SelectReader-win-x64.zip` do zapisovateľného priečinka a spusti `SelectReader.exe`. Reader sa otvorí v maximalizovanom okne. Potrebuješ Microsoft Edge; Node.js je pribalený.
2. Klikni na **Vybrať model**, zadaj server, vyber repozitár a model a klikni na **Otvoriť model**. Tvoj účet Windows musí mať prístup k zdieľaniu `\\server\enabler`. Prístup skontroluješ v tom istom dialógu cez **Overiť Windows pripojenie**.
3. V katalógu prepni medzi **Diagramy** a **Slovník**. Stlač `Ctrl+K` a vyhľadaj položku podľa názvu. Kliknutím na prvok diagramu otvoríš jeho detail a prepojenia. Na porovnanie diagramov vyber v ponuke **Rozloženie diagramov** dve alebo štyri okná.

V diagrame tried Reader zachováva poradie tried zhora nadol a zľava doprava podľa pozícií v modeli. Ak v balíku pozície chýbajú, použije dvojstĺpcové rozloženie. Čiarkovaná čiara medzi poznámkou a triedou označuje väzbu uloženú v modeli. Poznámky bez väzby zostávajú pod diagramom.

**Bez siete:** V dialógu **Vybrať model → Lokálne kópie** otvor uložený model. Kópia v priečinku `.cache` pri aplikácii nie je úplnou zálohou: bez siete otvoríš len diagramy a detaily, ktoré už Reader uložil.

**Export:** Klikni na **Export modelu do .md**, ponechaj predvolený priečinok `exports` alebo vyber vlastný a klikni na **Spustiť export**. Reader nechaj spustený a pripojený k serveru: export číta celý model aj pri otvorenej lokálnej kópii. Hotovú dokumentáciu otvor cez `index.md`.

## Zo zdrojov

**Aktualizácie:** Pri spustení Reader na pozadí skontroluje najnovší stabilný release na GitHube. Ak je novší, zobrazí odkaz na stiahnutie. Nič sám neinštaluje a bez internetu môžeš pracovať ďalej. Balíky staršie ako 1.1.0 túto kontrolu nemajú.

Na Windows potrebuješ Node.js 22 alebo novší. Príkazy spúšťaj v koreňovom priečinku projektu; `npm install` netreba.

| Úloha | Príkaz |
| --- | --- |
| Spustiť Reader na `http://127.0.0.1:4317` | `npm start` |
| Spustiť testy | `npm test` |
| Vytvoriť `dist\SelectReader-win-x64.zip` | `.\Build-Portable.ps1` |

[Skript na vytvorenie ZIP-u](./Build-Portable.ps1) spusti v PowerShelli s x64 verziou Node.js a kompilátorom C# z .NET Frameworku 4.x.

Pri vydaní nastav `version` v [package.json](./package.json) pred buildom. ZIP prilož k [GitHub Releases](https://github.com/DITEC-dobnak/SelectReader/releases) pod zodpovedajúcim tagom `vMAJOR.MINOR.PATCH` a vydanie označ ako najnovšie stabilné.
