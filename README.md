# Select Reader

Prehliadač modelov Select Architect pre Windows. Umožňuje prezerať diagramy a ich prepojenia a exportovať dokumentáciu do Markdownu. Model na serveri nemení a nepotrebuje Select Architect ani COM.

## Začni tu

1. Na Windows x64 rozbaľ celý `SelectReader-win-x64.zip` do zapisovateľného priečinka a spusti `SelectReader.exe`. Potrebuješ Microsoft Edge; Node.js je pribalený.
2. Klikni na **Vybrať model**, zadaj server a vyber repozitár a model. Reader použije tvoje Windows prihlásenie.
3. Vyhľadaj diagram a klikni na prvok. V detaile môžeš otvoriť prepojenú položku; **← Späť** ťa vráti na predchádzajúcu kartu.

**Bez siete:** V dialógu **Vybrať model** otvor lokálnu kópiu. Dostupné budú už uložené diagramy a detaily.

**Export:** Klikni na **Export modelu do .md**, vyber priečinok a spusti export. Výsledok otvor cez `index.md`. Export číta celý model zo servera, preto vyžaduje pripojenie aj pri otvorenej lokálnej kópii.

## Zo zdrojov

Na Windows s Node.js 22+ spusti `npm start`. `npm install` netreba. Testy spustíš cez `npm test`. Prenosný ZIP vytvoríš skriptom [Build-Portable.ps1](./Build-Portable.ps1); výsledok nájdeš v `dist\SelectReader-win-x64.zip`.
