# Select Reader — iba priamy prístup

Projekt už **neobsahuje COM konektor, jeho spúšťanie ani kompatibilný režim**.
Nepotrebuje Select klienta, Enabler DLL, Java/JEna ani SDK. Sieťový klient používa
štandardné moduly **Node.js 22+**. Windows prihlásenie navyše volá systémový
Windows PowerShell a `mpr.dll` cez vlastné malé OS prepojenie; nejde o COM ani
o komponent výrobcu Selectu. Neinštaluje sa .NET SDK ani iný runtime.
Nie je potrebné `npm install`.

## Čo teraz skutočne funguje

- Priame TCP spojenie s databázovým brokerom na porte 9700.
- **Predvolená autentifikačná cesta je Windows/SMB ako pri SFC/SFCCOM
  klientoch Selectu**, nie UserIdent. Overenie prístupu k `\\server\enabler`
  aj skutočnej sieťovej identity prebieha bez zadania hesla v aplikácii.
- Zoznam repozitárov a ich databázových portov získaný zo servera, nie z
  lokálnej konfigurácie Selectu. Klient načíta aj ďalšie stránky katalógu.
- **Priamy zoznam modelov vybraného repozitára**, bez knižníc výrobcu.
  Klient overí Windows prístup k serveru, otvorí vlastné TCP spojenie na
  databázový port z katalógu a prečíta objekty metatriedy `_Ent2_Model`.
- **Otvorenie obsahu vybraného modelu** cez jeho skutočný Enabler kontext.
  Diagramy sa indexujú ako prvé; ďalšie triedy objektov pribúdajú na pozadí.
  Vlastnosti a súvislosti sa čítajú pri otvorení detailu, nie cez starý klient.
- **Živé diagramy**: symboly, rozmery, pozície, uložené lomové body a väzby
  na slovníkové položky pochádzajú zo servera. SVG podporuje posun, zoom,
  hľadanie textu a prechod na detail položky. Ide o zjednodušené zobrazenie,
  nie identickú typografiu a všetky UML dekorácie Selectu.
- **Class a sequence majú samostatné moderné UML zobrazenie**, nie všeobecné
  obdĺžniky. Triedy zobrazujú atribúty, typy, operácie a parametre; asociácie
  načítajú obe roly a kardinality priamo podľa ID z diagramu. Dedičnosť
  smeruje od podtriedy k nadradenej triede podľa skutočných rolí, závislosť
  od závislého prvku k cieľu. Nie sú závislé od úplnosti globálneho indexu.
  Načítavajú sa iba príslušné významové väzby členov a rolí; neprechádza sa
  celý spätný index všetkých použití operácie v sekvenčných diagramoch.
  Skryté generované zdrojové súbory sa pri kreslení signatúry nečítajú.
- Sekvenčný diagram zostavuje životné línie a správy zo skutočných odosielateľov,
  prijímateľov a stromu krokov. Pre viac detí sa vyžaduje uložené používateľské
  poradie (`OSORLS6`, `SORTED_BY_USER`), nie zoradenie podľa GUID alebo času
  vytvorenia. Nejednoznačné poradie je chyba, nie vymyslená časová os.
  Ak má diagram viac koreňových krokov, ich poradie sa číta z väzby hlavičky
  štruktúrovaného popisu na kroky a kontroluje sa voči koreňom stromu.
  Sekvenčný pohľad podľa SQD zobrazuje vľavo strom čísiel a celé popisy,
  vpravo správy zarovnané k ich krokom. Vodorovné rozostupy životných línií
  vychádzajú z pozícií v modeli. Hlavičky rozlišujú `«user»` a `«interface»`
  a zobrazujú vlastné stereotypy. Popisy krokov sa zobrazujú celé.
  Zalamovanie, výšky riadkov a dĺžky aktivácií nie sú presnou
  reprodukciou desktopového klienta.
- Slovenské názvy v legacy úložisku `WESTERN` sa dekódujú ako pôvodné
  Windows-1250 dáta Selectu; `UNICODE` používa UTF-8. Dlhé textové hodnoty
  sa čítajú po blokoch. RTF sa mení na obyčajný text, nie aktívne HTML.
- Samostatné overenie účtu UserIdent cez TLS s kontrolou certifikátu alebo
  cez výslovne povolené nešifrované TCP. Obe cesty boli overené na testovacom
  brokeri; úspešný login
  so skutočným účtom v produkcii zatiaľ nebol overený.
- Otvorenie už existujúcich lokálnych kópií zo skoršieho načítania,
  vyhľadávanie bez diakritiky, uložené vlastnosti, súvislosti a uložené diagramy.
  Existujúce dáta v ignorovanom priečinku [.cache](.cache/) neboli zmazané.

**Úplnosť indexu je výslovná.** Počas načítania sa prehľadáva už načítaná
časť názvov a otvorených detailov. Úplný katalóg sa označí až po dokončení.
Pri prvom čítaní typu Reader čaká na jednotlivú odpoveď najviac 15 sekúnd.
Pri výpadku spojenia typ odloží na koniec a pokračuje ďalším typom.
Po prvom priechode skúsi iba odložené typy, každý ešte najviac dvakrát,
na novom spojení s limitom 60 sekúnd na odpoveď. Ďalší neúspešný pokus
opäť zaradí na koniec. Lišta zobrazí číslo pokusu aj kód predošlej chyby.
Čas opakovaných pokusov predlžuje desaťminútový rozpočet indexovania,
najviac na hodinu. Nedokončené stránky nepridáva. Pri pretrvávajúcom
výpadku pokračuje ďalším typom. Po dokončení čiastočného online priechodu odkaz
**Dočítať chýbajúce typy (N)** načíta iba typy, ktoré zlyhali, s limitom 60 sekúnd už od prvého ručného pokusu. Úspešne načítané typy
z otvoreného modelu zostanú zachované. **Načítať celý katalóg znova** spustí nový priechod od začiatku.
Chýbajúca trieda sa zaloguje kódom bez identity,
pri výsledkoch vyhľadávania sa zobrazí poznámka „Výsledky môžu byť neúplné“
namiesto červenej chyby nad diagramom. Lokálna kópia zostane označená ako neúplná.
Neznámy protokol, poškodené údaje ani chyby oprávnení sa nezamieňajú za úspech.

Predchádzajúci kód 7942 pochádzal z voliteľného testu UserIdent pre JEna,
nie zo správneho Windows/SFC pripojenia. Nedokazuje preto zamietnutie
prístupu k modelom cez Windows. Normálne otvorenie nepotrebuje UserIdent.
Aplikácia neskúša cudzie identity, neextrahuje interné prihlasovacie údaje
Selectu a neobchádza práva.
Diagnostické knižnice nie sú súčasťou aplikácie.

## Spustenie

1. Dvojklik na [Start.cmd](Start.cmd), alebo `npm start`.
2. Otvorí sa **http://127.0.0.1:4317**.
3. **Vybrať model** automaticky načíta repozitáre predvoleného servera.
   Po potvrdení zmeny servera sa zoznam obnoví. Hore sú naposledy otvorené
   modely na opätovné online otvorenie jedným klikom.
4. Vyber repozitár; modely sa načítajú automaticky. Pri chybe znova otvor dialóg
   alebo znovu vyber repozitár. Použije sa existujúce Windows
   sieťové prihlásenie, bez mena a hesla vo formulári. Samostatné
   **Overiť Windows pripojenie** je iba kontrola zdieľania, nie nutný predkrok.
5. Vyber model a klikni **Otvoriť model**. Index načítava názvy na pozadí.
   Kým načítavanie beží, pri počte objektov vidíš koliesko, aktuálny typ a prípadný opakovaný pokus. „Čiastočný katalóg“ sám osebe neznamená, že načítavanie ešte beží.
   Stredové tlačidlo **Pripojiť k serveru** sa zobrazuje iba bez otvoreného modelu.
   Detail a diagram sa načítajú kliknutím na výsledok; opakované otvorenie
   už používa lokálnu kópiu. Pri opätovnom online otvorení sa uložený index
   zobrazí hneď a overuje sa na pozadí. Staršie názvy sú výslovne označené;
   zmazané položky sa odstránia až po úplnom úspešnom novom načítaní.
6. Pre už uložené dáta zvoľ lokálnu kópiu v spodnej časti dialógu.
   **Zmazať kópiu** vyžaduje potvrdenie, zatvorí prípadný aktívny model
   a odstráni len jeho lokálnu kópiu. Server ani zoznam nedávnych modelov nemení.
   Voliteľné overenie Windows pripojenia nájdeš v zbalenej diagnostike dole.

Typ diagramu sa prepína jedným klikom: **Sequence**, **Class**, **Use Case**,
potom ostatné dostupné typy abecedne. Predvolené sú **sekvenčné diagramy (SQD)**.
Výsledky sú kompaktné textové riadky: CLD označuje modrá trieda ▤, SQD zelené šípky ⇄.
Diagramy
aj slovník zobrazujú vždy jeden konkrétny typ: všetky jeho nájdené položky
sú v jednom posúvateľnom zozname bez stránkovania.

Detaily nemajú záložky. Klik na názov diagramu zobrazí vlastnosti a súvislosti
v pravej lište. V online modeli tlačidlo **↻ Obnoviť** vedľa názvu znova načíta
iba aktuálny diagram zo servera, aj po chybe spojenia. V lište sú
pri SQD aj volajúce diagramy. Pri objektoch bez diagramu sú
vlastnosti priamo v detaile a pod nimi rozbaliteľné súvislosti.
Šírku ľavého katalógu aj pravej lišty zmeníš potiahnutím zvislého oddeľovača
alebo šípkami po jeho výbere cez Tab. Prehliadač si obe šírky zapamätá.
Pri načítaní alebo obnovení detailu vidíš čas od začiatku daného načítania (hh:mm:ss).
SQD sa otvorí od začiatku s textom krokov približne **12 pt**, bez ohľadu na dĺžku diagramu. Ostatné diagramy sa otvoria celé.
Pri otvorenom diagrame **Ctrl +** približuje a **Ctrl −** odďaľuje diagram namiesto celej stránky. Fungujú aj klávesy na numerickej klávesnici.
**Tmavý režim** v hornej lište prepína aj farby SQD a CLD. Pred prvou voľbou sa
použije nastavenie systému; vlastná voľba zostane uložená v prehliadači.
HTML popisy v detaile prvku a v pravej lište sa zobrazujú ako čistý text bez formátovacích značiek.
V SQD označuje šípka **↗** odkaz na iný sekvenčný diagram. Klik naň zobrazí detail v pravej lište.
Až odkaz **↗ názov diagramu** v lište otvorí cieľ. Sekcia **Volané z SQD** rovnakými odkazmi zobrazí diagramy, ktoré
odkazujú na cieľ cez `probe`; otvoríš ju aj kliknutím na názov otvoreného SQD.
Klik
na text alebo šípku správy otvorí v pravej lište jej celý opis zo slovníka
bez odchodu zo sekvenčného diagramu. Klik
na hlavičku triedy zobrazí detail; až **Otvoriť súvisiaci CLD** vyhľadá diagram podľa jej skutočných symbolov. Dvojklik na text v SQD aj CLD označí slovo bez presmerovania. Pri viacerých
cieľoch sa zobrazí výber; **Späť na diagram** sa vráti k zdrojovému diagramu.
Na SQD aj CLD koliesko posúva zvisle, Shift+koliesko vodorovne a Ctrl+koliesko
mení mierku. Touchpad podporuje posun v oboch osiach. Na oboch diagramoch
je stereotyp `«user»` zelený a `«interface»` modrý s bielym písmom.
Text v diagrame aj v pravej lište označíš ťahaním a skopíruješ cez **Ctrl+C**.
Diagram posunieš ťahaním mimo textu alebo kolieskom. Posun sa zastaví na okrajoch diagramu. Ak sa celý diagram
zmestí do okna, zostane zarovnaný vľavo hore a nedá sa odsunúť do prázdna.
Pri otvorenom diagrame sa hlavička automaticky zmenší. V dvojstĺpcovom
pracovnom priestore sa diagramy otvárajú na kartách nad hlavičkou. Každá karta má celý názov diagramu a vlastné × na zatvorenie. Opätovný výber
toho istého diagramu aktivuje jeho kartu. Karty zachovávajú posun, zoom a hľadanie;
zatvoríš ich cez × alebo prostredným tlačidlom myši. Pri zameranej karte fungujú
šípky ←/→, Home/End a Delete. Pri zmene modelu sa karty zatvoria. V dvojstĺpcovom
zobrazení využije plátno zvyšnú výšku okna; katalóg sa posúva samostatne.
V CLD klik na triedu, atribút alebo operáciu otvorí detail v pravej lište bez
opustenia diagramu. V sekcii **Vlastnosti** vidíš `Description` a `Attribute declaration`, ak ich prvok má.
V **Ďalšie vlastnosti** hviezdička ☆ pripne pole k predvoleným a ★ ho odopne. Voľba sa pamätá v prehliadači aj pre ďalšie prvky s rovnakým poľom. Sekciu **Súvislosti** rozbalíš priamo v lište;
aj výber súvisiaceho prvku zobrazí jeho detail v tej istej lište bez zmeny diagramu. „Binárna príloha“ označuje konkrétne
netextové pole, nie celý atribút ani jeho deklaráciu.

Po štarte sa žiadny model ani externý program na čítanie modelov nespúšťa.
Konzolu nechaj otvorenú; ukončenie je **Ctrl+C**. Server počúva iba na
`127.0.0.1`, má kontrolu Host/Origin a nesprístupňuje súbory lokálnej cache.

Samostatný priamy TCP klient bez webového rozhrania:

```powershell
node direct-broker.mjs select.example
# alebo
npm run probe -- select.example
```

## Protokol a obmedzenia

[direct-broker.mjs](direct-broker.mjs) implementuje vlastný klientsky protokol
podľa pozorovanej čítacej výmeny metadát. Nepreberá implementáciu knižníc
výrobcu, neobsahuje ich binárky ani zachytené prevádzkové dáta.

Podporovaný je pozorovaný profil brokera **Enabler 8.1 na Windows Server 2012**,
UTF-8 metadáta a stránkovaný katalóg. Podporuje sa TCP fragmentácia.
Každý kurzor sa vracia bez zmeny na to isté spojenie až po koncový marker;
opakovaný kurzor, duplicitná položka či zlyhanie ďalšej stránky nezverejnia
prvú stránku ako kompletný výsledok. Chýbajúci hostiteľ lokálneho záznamu
znamená server práve vykonaného dotazu, rovnako ako v oficiálnom 8.1 API.
Iná verzia, nezodpovedajúca hlavička, neznáme záznamy,
poškodené dĺžky, timeout alebo predčasné ukončenie spojenia skončia chybou,
nie neúplným úspešným výsledkom. Timeout celého pokusu je 5 sekúnd.

Klient podporuje dohodu protokolu, katalóg, prihlasovacie kontexty, samostatné
overenie UserIdent a čítanie zoznamu modelov. [direct-models.mjs](direct-models.mjs)
a [native-content.mjs](native-content.mjs) na databázovom porte používajú
vyjednanie, `OSCLST`, `OSOLST`, `OSOALST`, `OSOAGET` a `OSORLS3`.
`OSOTXGET` načíta definíciu kontextu; `OSOTXSET` zvolí pracovný kontext iba
aktuálnej klientskej relácie. Nemení definíciu modelu, workspace, oprávnenia
ani používateľov predvolený kontext.

Zoznam modelov používa nulový predvolený kontext; obsah používa vybraný
kontext modelu. Marker brokera ani identifikátor aplikácie nie sú kontext.
Pri pokračovaní sa podľa `PI_RESTART_LEN` zachová celý prefix odpovede
**vrátane nepriehľadnej hlavičky a počítadla**, nie len telo parametrov.
Neukončené alebo opakované stránkovanie nezverejní triedu ako úplnú.
Identita objektu zahŕňa triedu aj databázový identifikátor. Sieťová identita
zostáva iba v backende; API ani cache neobsahujú prihlasovací účet alebo heslo.
Spojenia sa po dávke uzavrú. Nie je tu zápis do modelov ani náhradný konektor.

Index má limit 200000 objektov a desať minút; jedna trieda najviac 100000
objektov. Diagram má limit 2000 symbolov a jedna príloha 4 MiB. Prekročenie
limitu je explicitná chyba, nie označenie čiastočných dát za úplné.
Binárne prílohy sa nevydávajú za čitateľný text. Ich prítomnosť sa v detaile nezobrazuje ako upozornenie. Nepodporované typy vlastností
majú upozornenie a pôvodné bajty; nepodporovaná geometria sa nevymýšľa.

## Zadanie prihlasovacích údajov

### Normálna cesta: Windows prihlásenie bez hesla v aplikácii

Oficiálny manuál **Enabler 8.1 Administration, §2.6.2 a §3.4.3** rozlišuje
SFC/SFCCOM a JEna. Natívny Select má načítané SFC/Cna knižnice; tieto
klienty sa autentifikujú prístupom k Windows zdieľaniu `enabler`.
Windows použije aktuálne prihlásenie alebo identitu existujúceho
sieťového pripojenia. Tá sa môže líšiť od účtu procesu z `whoami`.

[windows-smb.mjs](windows-smb.mjs) používa štandardné Windows API
`WNetAddConnection2` a `WNetGetUser`, iba v kontexte aktuálneho používateľa.
Pripojenie je bez písmena disku, s vypnutým zapamätaním profilu a bez
zadania alebo čítania hesla. Overuje sa aj právo čítať `omsbroker`.
Existujúce spojenia sa nikdy neodpájajú, nemenia sa uložené údaje ani
oprávnenia a nevyžaduje sa administrátorský zoznam globálnych SMB relácií.
Pri chybe sa nepoužije náhradná identita z `whoami` ani UserIdent.
Samostatné overenie zdieľania neotvára modelovú databázovú reláciu.
Tú otvorí až výber modelu.

### Rozšírená diagnostika: JEna UserIdent

Nasledujúci formulár je voliteľný a zbalený. **Nie je podmienkou normálneho
Windows/SFC pripojenia ani dôvodom žiadať registráciu vo UserIdent pre Select.**

V dialógu vyber server a repozitár. V časti **Overiť prihlasovacie údaje**
možno použiť dve cesty:

- **Bežné TCP:** zaškrtni **Použiť bežné TCP pripojenie na porte 9700 bez
  šifrovania**. Port 9700 sa vyplní automaticky. Klikni **Pripraviť bežné
  pripojenie** a potom zadaj meno a heslo.
- **TLS (predvolené):** zadaj TLS port brokera a klikni **Overiť zabezpečené
  spojenie**. Overuje sa aj certifikát.

Po overení podporovaného profilu sa odomknú polia doména, meno a heslo.
Meno možno zadať aj ako `DOMENA\meno`.

- **Použiť Windows účet procesu aplikácie** iba predvyplní meno a doménu,
  bez hesla a bez pripojenia k modelovému serveru. Je to identita lokálneho
  procesu Node.js, nie automatické doménové prihlásenie prehliadača.
  Ak ide o lokálny účet počítača, UI to výslovne uvedie. Hodnoty sa neukladajú.
  Na tomto počítači bola táto identita porovnaná s `whoami`; zhodovala sa.
  Ak už bol rovnaký účet odmietnutý kódom 7942, nemá zmysel opakovať heslá:
  správca musí overiť jeho zápis v UserIdent na cieľovom serveri.
- Pri Windows serveri sa v overovacom pakete použije celé **`DOMENA\meno`**,
  pričom samotné meno a doména zostanú aj v samostatných poliach protokolu.
  Operačný systém pochádza z overenej odpovede brokera, nie z operačného
  systému klienta ani z používateľom dodaného prepínača.
  Tým je opravené predchádzajúce zahodenie domény, ktoré mohlo vyvolať kód 7942.
- Heslo môže zostať prázdne, ak ho účet v UserIdent nevyžaduje. Klient
  neposiela náhradné heslo a pri odmietnutí neskúša ďalšie varianty.
- Katalóg na porte 9700 používa obyčajné TCP; to nie je overený TLS vstup.
  V explicitne povolenom TCP režime sa heslo prenáša **čitateľne** a môže ho
  zachytiť niekto s prístupom k sieťovej prevádzke. Voľba je predvolene vypnutá,
  neukladá sa a pri zmene servera sa zruší. API vyžaduje `allowPlaintext: true`
  pri príprave aj pri samotnom overení; reťazec `"true"` sa nepovažuje za súhlas.
- V TLS režime sa vyžaduje TLS 1.2+ a dôveryhodný certifikát pre zadaný názov servera.
  Nie je tu prepínač ignorovania certifikátu ani automatický nešifrovaný fallback.
  Ak treba firemnú CA, používajú sa aj systémové korene, keď ich Node
  sprístupňuje; prípadne spusti Node s `NODE_EXTRA_CA_CERTS` nastaveným na
  dôveryhodný CA súbor od správcu. Nepridávaj neoverený serverový certifikát.
- Po kliknutí **Overiť účet** sa údaje z formulára ihneď vyčistia.
  Vyčistia sa aj pri zmene cieľa alebo zatvorení dialógu.
- Heslo sa neukladá do súborov, cache, cookies, localStorage ani sessionStorage.
  Backend ho drží len počas jednej požiadavky; odosielaný prihlasovací buffer
  sa po skončení prepíše nulami. JavaScriptové reťazce podliehajú správe
  pamäte runtime — aplikácia nesľubuje úplné vymazanie všetkých kópií z RAM.
- Prihlasovacie chyby aj logy sú sanitizované. Serverové texty, ktoré by
  mohli obsahovať heslo, sa nevracajú klientovi ani nelogujú.
- Nie sú automatické opakovania pokusu a súbežne prebieha najviac jedno
  overenie. Ide o jednorazovú kontrolu, nie uloženú prihlasovaciu reláciu.
- Podporený je len pozorovaný profil `client` / `default` alebo
  `user_ident_by_file`, metóda **UserIdent**. Nie je implementované ADS,
  Windows SSO ani všeobecné vykonávanie JAAS modulov. Doménové pole samo osebe
  nemení nastavený spôsob autentifikácie servera.
- Kód **7942** znamená, že meno sa nenašlo v serverovom súbore `user_ident`.
  Nie je to chyba hesla. Kód **7943** znamená neplatné heslo pre tento súbor.
  Najprv skontroluj správny tvar `DOMENA\meno` a zaradenie účtu na cieľovom
  serveri. Zápis Windows účtu v UserIdent nie je to isté ako priame ADS/SSO.
- Profil klienta **8.1 používa UTF-8** aj pre prihlasovacie polia. Starší
  7.0 formát používaný pri prvých pokusoch nebol správnou referenciou pre
  tieto správy. Neplatné Unicode reťazce sa odmietnu bez nahrádzania znakov.
  Podporovaný limit každého prihlasovacieho poľa je 255 UTF-8 bajtov,
  nie 255 znakov; rozšírená dĺžka sa overuje aj pre viacbajtové heslá.
- Každý prihlasovací paket obsahuje verziové pole `PI_MOD_VERSION` (`0x9f`)
  zodpovedajúce profilu 8.1, správny predrelačný kontext a číslo požiadavky.
  Nie je to identifikátor už prihláseného používateľa.

[native-auth.mjs](native-auth.mjs) nepoužíva knižnice výrobcu. Formát čítacej
autentifikačnej výmeny bol overený pomocou syntetických údajov zachytených
a **zablokovaných pred odoslaním na server**. Skutočné heslá do diagnostiky
neboli zadávané. Regresný test porovnáva **celý paket po bajtoch** s nezávislou
referenciou dodaného 8.1 klienta, nie iba s odpoveďou nášho mock servera.
Referencia obsahuje iba vymyslené údaje; názov repozitára a premenlivé číslo
požiadavky boli normalizované. Zhoda bola samostatne overená aj pre celé
úvodné vyjednávanie protokolu.

### Zistenia z dodaného inštalačného balíka 8.1

Lokálny návod nastavuje v `jaas.conf` predvolený `ELoginModuleUserIdent`
namiesto ADS a opisuje registráciu Windows účtu v tvare `DOMENA\meno:`
v serverovom `user_ident`. Ide o postup pre lokálnu inštaláciu: pre vzdialený
model je rozhodujúca konfigurácia na jeho serveri, nie lokálny súbor klienta.
Zdieľané heslo ani účty z príkladov sa do aplikácie nepreberajú.

Porovnanie s prihlasovacím formátom dodaného klienta 8.1 potvrdilo, že na
Windows treba doménu zachovať v úplnom mene. Žiadny inštalátor sa nespustil,
žiadna knižnica výrobcu nebola pridaná do runtime a serverové konfiguračné
súbory ani registre sa nemenili.

Lokálne kópie sú nešifrovaný JSON pod oprávneniami používateľa. Obsahujú
skutočný obsah analýzy: nekomituj ich a nesprístupňuj cez zdieľaný disk.
Uložené texty sa zobrazujú ako text, nie ako aktívne HTML. Aplikácia nemá
externé fonty, CDN, telemetriu ani cloudové API.

## Markdown export modelu

V otvorenom online modeli zvoľ **Export modelu do .md**. Tlačidlom
**Vybrať priečinok…** otvorí bežný dialóg Prieskumníka Windows s adresným riadkom;
cieľ môžeš vybrať alebo vložiť jeho cestu. Bez výberu sa použije
`SelectReader\exports`. Potom klikni na **Spustiť export**. Pokračovanie
rozpracovaného exportu vždy používa jeho pôvodný priečinok.
Po spustení alebo pokračovaní sa dialóg zatvorí. Horné tlačidlo exportu
ukazuje fázu a počet spracovaných položiek; kliknutím otvoríš podrobnosti.
Pri chybe sa celé tlačidlo s nápisom **Export: chyba** zafarbí načerveno. Po úspešnom spustení pokračovania sa vráti k bežnej farbe.
V lište aj v detaile je čas exportu (hh:mm:ss). Pokračovanie ho počíta ďalej
bez času stráveného prestávkou; nový export začína od nuly.
Zatvorenie karty export nezastaví. Po zatvorení poslednej karty Reader počká
15 sekúnd (obnovenie stránky ho nevypne); ak beží export, vypne sa až po jeho
skončení. Ďalšia otvorená karta automatické vypnutie zruší. Cez **Reader…**
v hornej lište ho možno ručne vypnúť alebo reštartovať pre všetky karty.
Po reštarte otvor model znova; počas exportu sú tieto operácie blokované.
Pri prerušení TCP spojenia počas čítania diagramov alebo referencií export
zopakuje práve rozčítaný objekt na novom spojení (najviac 10 opakovaní).
Hotové diagramy nečíta znova; neúplný výsledok nevydá za hotový export.
Pri zlyhaní uvedie konkrétnu položku príslušného čítania, nie poslednú položku z iného paralelného spojenia.
Ak export skončí chybou, Reader po 10 sekundách automaticky skúsi pokračovať raz z posledného uloženého stavu.
Čakanie môžeš zastaviť. Ručne zastavený export sa sám nespustí; po ďalšej chybe zostane dostupné ručné pokračovanie, ak má export uložený priebeh.
Ak sú niektoré kroky SQD mimo overenej hierarchie, export ich vypíše v časti
**Kroky bez overeného poradia**, nie v časovej osi. Upozornenie obsahuje aj hlavný index.
Export nezávisí od zvoleného filtra ani od čiastočnej cache: vyžiada si nový
zoznam všetkých tried diagramov a po dávkach prečíta obsah cez priame spojenie.
Počas jedného exportu si pamätá definície najviac 512 tried aj medzi dávkami.
Diagramy číta až 20 súbežných spojení. Dokončené diagramy ukladá samostatne;
odkazy a Markdown zostavuje v stabilnom poradí, nie podľa poradia dokončenia.
Typ atribútu, typ parametra a triedu roly zisťuje z väzieb konkrétneho objektu
namiesto samostatných požiadaviek pre každý možný cieľový typ. Z dlhých
príloh číta iba polia potrebné na vytvorenie dokumentácie.
Pri SQD nenačítava údaje o vzhľade hlavičiek, ktoré sa do Markdownu nezapisujú.
Nespúšťa COM, Select Architect ani pôvodný exportný skript. Súbežne môže bežať
len jeden export. Zatvorenie dialógu ho nezastaví.

Každý nový beh má vlastný priečinok `exports/export-…/<model>_<repozitár>_<RRRR-MM-DD>/`
(napríklad `Model_Example_2026-11-19`). Pri pokračovaní zostáva dátum pôvodného behu. V priečinku je koreňový
`index.md`, indexmi typov, stránkami diagramov, `Events.md` a `Other classes.md`.
Súbory sú UTF-8 bez BOM s LF a relatívnymi odkazmi. Ide o samostatnú
implementáciu formátu: napríklad ID kotiev, výber pri duplicitných názvoch,
Mermaid rozloženie a zápis vnorených krokov nemusia byť identické s COM exportom.
Počet diagramov sa určuje podľa aktuálneho serverového indexu, nie lokálnej kópie.

Neúplný beh sa nepublikuje. Po zastavení/chybe možno v tom istom procese
pokračovať s uloženými detailmi diagramov; počas prerušenia neupravuj model.
Predchádzajúce finálne exporty sa neprepisujú. Výstup aj pracovné dáta
obsahujú obsah modelu v otvorenom texte a sú ignorované Gitom.

## Testy

```powershell
npm test
```

Testy pokrývajú sieťové rámce a chyby protokolu, fragmentáciu, timeout/EOF,
offline dáta, vyhľadávanie, izoláciu cache, HTTP obmedzenia a odstránenie
starého konektora. Výkonnostný test overuje hľadanie v 20 000 objektoch pod
200 ms po vytvorení indexu.

TLS testy generujú dočasný syntetický certifikát pomocou OpenSSL. Na Windows
sa predvolene používa OpenSSL z Git for Windows; inú cestu možno zadať cez
`OPENSSL_PATH`. Testovací súkromný kľúč nevzniká v projekte a po testoch sa odstráni.
Testy overujú nedôveryhodný certifikát, zákaz nešifrovaného hesla bez súhlasu,
výslovne povolené TCP, kódovanie,
sanitizáciu odpovedí/logov, vyčistenie polí a absenciu automatických opakovaní.
Modelové testy overujú nulový databázový kontext, úplný rámec `OSOLST`,
UTF-8, viacstránkový zoznam, návrat nezmeneného prefixu, duplicity, nesúlad
identity a zákaz zverejnenia čiastočného zoznamu alebo sieťovej identity.
Obsahové testy pokrývajú číslicové súradnice, skutočné koncové body spojníc,
viacdielne textové hodnoty, RTF/Unicode, triedené identity objektov,
online/offline otvorenie a oddelenie nových kópií od starých dát.

Živý test priameho TCP klienta sa zapína explicitne:

```powershell
$env:SELECT_DIRECT_SERVER = 'select.example'
node --test tests\direct-broker.test.mjs
```

Spúšťa samostatný Node.js proces s prázdnymi `PATH`, `CLASSPATH`
a `JAVA_HOME`, aby overil nezávislosť od programov a knižníc výrobcu.

Živý test modelov používa aktuálne Windows sieťové prihlásenie a nič nezapisuje:

```powershell
$env:SELECT_MODEL_SERVER = 'select.example'
$env:SELECT_MODEL_REPOSITORY = 'Example'
$env:SELECT_MODEL_EXPECTED = 'Model A|Model B'
node --test tests\direct-models.test.mjs
```

`SELECT_MODEL_EXPECTED` je voliteľná kontrola presného zoznamu názvov.

Živá regresia obsahu a geometrie: zadaj vlastný diagram prípadov použitia s väzbou do slovníka a tokom.

```powershell
$env:SELECT_CONTENT_SERVER = 'select.example'
$env:SELECT_CONTENT_REPOSITORY = 'Example'
$env:SELECT_CONTENT_MODEL = 'Model A'
$env:SELECT_CONTENT_DIAGRAM = 'Example use case'
node --test tests\native-content.test.mjs
```
