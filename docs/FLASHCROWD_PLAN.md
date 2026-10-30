# FlashCrowd: inceleme ve 4 kişilik görev planı

> **Not (30 Ekim akşamı).** Bu plan FlashCrowd'a geçerken yazıldı ve olduğu gibi duruyor. Planda geçen "testnet"
> adımları mainnet'te yapıldı, çünkü görevlilerde testnet coin yoktu (ağı `BSV_NETWORK` seçer). Güncel durum ve
> işlem linkleri için [README](../README.md)'ye, adımların sonuçları için issue'lara bakın.

Oct 30, 2026 · @Efe

## Özet

FlashCrowd'a geçiş doğru karar ve core tarafı beklenenden hızlı ilerliyor: PR #12 ile HTLC akışı, grup mantığı ve harcama politikası yazıldı ve 55 testle geçiyor. Artık en büyük risk kod değil, iki doğrulanmamış testnet davranışı ve sunucu, ajan ve web'in henüz başlamamış olması.

FlashCrowd'da birkaç AI ajanı, tek başına alamayacağı bir dataseti birlikte satın alıyor. Her ajan payını kendi HTLC kasasına kilitliyor. Satıcı parayı ancak şifre çözme anahtarını zincirde açıklayarak tek işlemde alıyor. Anahtar açıklanmazsa her ajan belli bir blok yüksekliğinden sonra parasını geri alıyor.

_(Diyagram: FlashCrowd akışı · 4 taraf, 7 adım ve iade yolu)_

Adım 4 ile 5 arasındaki sıra güvenliğin temeli: ajan, iade ön imzasını eline almadan fonlamayı yayınlamaz.

| Track şartı | FlashCrowd'da karşılığı | Durum |
| --- | --- | --- |
| BSV TypeScript stack | @bsv/sdk 3.2.1 + wallet-toolbox 2.14.9, HTLC script'i SDK ile | PR #12'de, mock chain'de 55 test geçiyor |
| Standart BSV cüzdanı | Kullanıcı BSV Desktop ile ajanı fonlar veya gruba katılır | BSV Desktop davranışı denenmedi |
| Gerçek işlemler | Fonlama, claim ve iade işlemleri testnet'te, WoC linkleriyle | Testnet script'i yok, test coin bekleniyor |
| Non-custodial | Para alıcının HTLC'sinde, koordinatör anahtar ve para tutmaz | Tasarımda ve core'da var |
| Ödeme yapan AI ajanı | 2–3 ajan kendi cüzdanından HTLC fonlar | Ajan kodu yok |

Bugün verilmesi gereken dört karar:

1. PR #11 ve ardından PR #12 merge edilsin. #12, #11'in üzerine kurulu, merge sonrası `main`'e yönlendirilmeli.
2. Görev dağılımı yeniden netleşsin: core'u P3 (@efeberkinaslan07-rgb) yazdı. Web ve ajan işini kimin yapacağı açık.
3. Test coin'ler gelince ilk iş testnet doğrulama script'i yazılsın. Sonuca göre plan B devreye girer (son bölüm).
4. Sunucuda BRC-103 auth zorunlu: `types.ts`, ajan kimliğini istek gövdesinden değil auth'tan almayı şart koşuyor.

## PR incelemesi: #11 ve #12

İki PR da sağlam ve merge edilmeye hazır. Tek kritik eksik testnet doğrulaması, o da PR'ların değil bir sonraki adımın işi. #12, #11'in üzerine kurulu: önce #11, sonra #12 merge edilmeli.

| PR | Yazan | İçerik | Kanıt |
| --- | --- | --- | --- |
| [#11](https://github.com/NotBot-Computer/agentswap-bsv/pull/11) FlashCrowd task brief + HTLC spike | @NotBot-Computer | `docs/FLASHCROWD_TASK.md` ve 8 testlik HTLC denemesi | 8 testi kendim çalıştırdım, geçti |
| [#12](https://github.com/NotBot-Computer/agentswap-bsv/pull/12) FlashCrowd core | @efeberkinaslan07-rgb | `types.ts`, `htlc.ts`, `collective.ts`, `spendPolicy.ts`, README API tablosu. Spike testleri gerçek testlerle değişti | 55 test (13 swap + 42 yeni), CI yeşil, conflict yok |

PR #12'nin mock chain'de gösterdikleri:

- Üç alıcı 3.000 + 4.000 + 5.000 sats fonluyor, satıcı hepsini tek claim'de alıyor (11.947 sats), alıcı K'yi okuyup dataseti çözüyor.
- İki alıcı süre dolunca iade alıyor. Süre dolmadan iade "not final" diye reddediliyor.
- Reddedilenler: değiştirilmiş veya sahte şartlar, yanlış miktar veya script, iade imzası olmadan yayınlama, yanlış anahtarla claim, eksik katkıyla claim, ikinci claim, süre dolduktan sonra claim, başkasının iadesi.

Önceki incelemede saydığım sorunların çoğu PR #12'de kapandı:

| Önceki bulgu | PR #12'de durum |
| --- | --- |
| Spike `counterparty: 'self'`, doküman `'anyone'` | Kapandı: anahtarlar `'anyone'` ile türetiliyor |
| Süre dolunca claim ve iade yarışır | Büyük ölçüde kapandı: `claimContributions` `refundHeight`'tan itibaren reddediyor |
| Pay, onaydan sonra değişebilir mi? | Kapandı: paylar satıcının imzaladığı şartların içinde |
| Fonlama iade imzası olmadan yayınlanabilir mi? | Kapandı: `broadcastContribution` geçerli imza olmadan reddediyor |
| İade reddini ağ değil cüzdan test ediyor | **Açık, kritik:** testnet script'i yazılmadı |
| Ağ zamanı gelmemiş işlemi bekletirse sabotaj riski | **Açık:** aynı testnet denemesinde ölçülecek |

PR #12 için yeni bulgular:

| Bulgu | Önem | Öneri |
| --- | --- | --- |
| Claim için güvenlik payı yok: `refundHeight - 1`'de yayınlanan claim bloğa girene kadar iade de geçerli olabilir | Orta | Claim'i `refundHeight - 2` veya `-3`'ten itibaren reddet |
| `agentIdentityKey` BRC-103 auth'tan alınmalı | Orta | BRC-103 artık sunucuda zorunlu (P2) |
| `expiresAt` Unix ms, `createdAt` ISO | Düşük | Sunucu ve web'de dikkat edilmeli |
| Grup durumu 11 olarak kaldı | Bilgi | Hepsi yazılmış ve test edilmiş, sadeleştirme önerisi geri çekildi |
| Core'u P3 yazdı | Bilgi | Web işinin sahibi yeniden konuşulmalı |

## Kapsam ve milestone'lar

Hedef, Cumartesi 10:00'da testnet'te gerçek işlemlerle çalışan tek bir demo akışı: üç ajan bir grup kurar, fonlar, satıcı claim eder, ajanlar dataseti açar. Ayrı bir denemede bir iade gösterilir. Core büyük ölçüde hazır olduğu için kritik yol artık sunucu ve ajanlar.

| Kapsamda | Kesilen veya sonraya kalan |
| --- | --- |
| Core: PR #12 (bitti), testnet script'i, claim güvenlik payı | Fiyat karşılaştırma ve itibar puanı (pitch'te "sonraki adım") |
| Koordinatör API'si, BRC-103 auth, mock satıcı, SSE feed | Altı doküman yerine README, DEMO ve kısa bir SECURITY bölümü |
| 3 ajan, deterministik akış, isteğe bağlı LLM anlatımı | Gruba web'den katılma (sadece BSV Desktop denemesi olumluysa) |
| Dashboard ve tek bir gerçek kullanıcı akışı (ajanı fonlama) | Eski swap kodu silinmez ama demo yolunda yer almaz |
| Testnet doğrulamaları ve WoC link tablosu |  |

| Milestone | Bitmiş olması gereken |
| --- | --- |
| M1, Cuma 18:00 | #11 ve #12 merge edildi. Sunucu API önerisi onaylandı. Test coin'ler geldi. Testnet doğrulama script'i yazılıyor |
| M2, Cumartesi 02:00 | Bütün akış mock chain'de uçtan uca çalışıyor: core + sunucu + ajanlar. Testnet doğrulamalarının sonucu belli. Dashboard sahte veriyle hazır |
| M3, Cumartesi 10:00 | Testnet'te gerçek fonlama, claim ve iade işlemleri, WoC linkleriyle. Dashboard canlı API'ye bağlı. Demo ortamı dışarıdan erişilebilir |
| Freeze, Cumartesi 12:00 | GitHub milestone'una göre kod dondurma. Sonrası sadece video, README ve Devfolio |
| Teslim | Video (≤ 2:30), repo public. **Deadline saati organizatörlerden teyit edilmeli** |

Testnet'te bir blok yaklaşık 10 dakika. İade senaryosu birkaç blok bekletir, bu yüzden en geç Cumartesi sabahı ilk saatlerde bir kez çalıştırılmalı. Video için önceden kaydedilir.

## P1: On-chain core (@NotBot-Computer, `packages/core`)

Core'un kodu PR #12 ile büyük ölçüde bitti. P1'in kalan işi testnet: planın karar kapısı olan doğrulama script'i ve WoC linkleri.

- [x] `types.ts`: FlashCrowd tipleri ve yeni `SpendPolicy` (PR #12)
- [x] `htlc.ts`: `newSecret`, `encryptResource`, `decryptResource`, `htlcKey`, `htlcKeyOf`, `htlcScript`, `signTerms`, `verifyTerms`, `prepareContribution`, `signRefund`, `verifyRefundSignature`, `broadcastContribution`, `abandonContribution`, `verifyFunding`, `claimContributions`, `secretFromClaim`, `refundContribution` (PR #12)
- [x] `collective.ts`: `splitPrice`, `openGroup`, `matchIntents`, `advanceGroup` (PR #12)
- [x] `spendPolicy.ts`: `checkSpend`, `assertSpend` (PR #12)
- [x] 42 yeni test, eski 13 swap testi geçiyor (PR #12)

Kalan adımlar:

1. **PR'ları merge et (hemen).** Önce #11, sonra #12'yi `main`'e yönlendirip merge et. Herkes `main`'i pull etsin.
2. **Claim güvenlik payı (\~15 dk).** `claimContributions`, `height >= refundHeight - CLAIM_MARGIN_BLOCKS` olduğunda reddetsin (öneri: 2–3 blok). Bir test ekle.
3. **Testnet doğrulama script'i (coin gelir gelmez, en önemli iş).** `packages/core/scripts/testnet-htlc.ts`: wallet-toolbox cüzdanları key dosyalarından, `Services` + `arcadeUrl = ARCADE_URL.testnet`.
   - a) İki alıcı fonlar, satıcı claim eder: üç WoC linki.
   - b) Zamanı gelmemiş iadeyi Arcade'e gönder: reddediliyor mu, bekletiliyor mu? Bekletiliyorsa satıcının claim'i hâlâ geçiyor mu?
   - c) `refundHeight`'tan sonra iade: WoC linki.
   - Sonuçları issue #2'ye yaz. Plan B kararı buna bağlı (son bölüm).
4. **Satıcı cüzdanı fonsuzken claim.** Testnet'te satıcı cüzdanı boşken claim'in ücreti HTLC değerinden ödeyebildiğini doğrula.
5. **P3 ile BSV Desktop denemesi (M2'den önce).** `noSend` / `sendWith`, özel locking script ve `createSignature({ hashToDirectlySign })` testnet'te çalışıyor mu? `manifest.json`'a `flashcrowd htlc` ve `flashcrowd terms` protokollerini ekleyin.
6. **Sunucu ve ajanlara destek.** P2 ve P4 core fonksiyonlarını bağlarken çıkan sorulara hızlı cevap. Gerekirse küçük core PR'ları.
7. **Teslim işi.** README'deki WoC link tablosunu gerçek txid'lerle doldur.

## P2: Backend (@efekaansalici07-design, `apps/server`)

Sunucu artık kritik yolda: core hazır, ajanlar ve web sunucuyu bekliyor. Sunucu grupları tutar, core fonksiyonlarını doğru sırayla çağırır ve feed'i yayınlar. Hiçbir alıcının anahtarını ya da parasını tutmaz. Mock satıcı kendi cüzdanı olan ayrı bir modül.

1. **İskeleti geri getir (\~20 dk).** M1'de yazılan ama clone'da olmayan kodu Claude'dan al: key dosyasıyla kurulan cüzdan (`src/wallet.ts`), `wallet:init` script'i, CORS ve Express yapısı. Cüzdan mock satıcının cüzdanı olacak. Eski teklif listesi ve 402 servisi yeni planda yok.
2. **BRC-103 auth (ilk iş, zorunlu).** `@bsv/auth-express-middleware` 2.2.9 sunucuya, ajanlar `AuthFetch` ile çağırır. `PurchaseIntent.agentIdentityKey` ve katılımcı kimliği her zaman auth'tan gelir, istek gövdesinden asla. Okuma endpoint'leri (`GET /api/services`, `GET /api/groups/:id`, `GET /api/feed`) web için auth'suz kalabilir.
3. **API önerisi (M1'den önce).** Aşağıdaki tabloyu istek ve cevap gövdeleriyle yaz, P1 ve P4'ün onayını al. Tipler `types.ts`'den.

   | Endpoint | Ne yapar | Çağırdığı core fonksiyonu |
   | --- | --- | --- |
   | `GET /api/services` | Mock satıcının `ServiceOffer` listesi |  |
   | `POST /api/intents` (auth) | `NewIntent` alır, `PurchaseIntent` yaratır, eşleştirmeyi dener | `matchIntents` veya `openGroup` + `advanceGroup({type:'join'})` |
   | `GET /api/intents` | Niyet listesi |  |
   | `GET /api/groups/:id` | Grup, katılımcılar, şartlar, şifreli veri, durum, işlem linkleri |  |
   | `POST /api/groups/:id/authorize` (auth) | Ajan şartları kabul eder | `advanceGroup({type:'authorize'})` |
   | `POST /api/groups/:id/contributions` (auth) | Ajan `FundingContribution` gönderir (BEEF yok), satıcının iade imzasını döndürür | `signRefund` |
   | `POST /api/groups/:id/funding` (auth) | Ajan BEEF'li katkıyı gönderir | `verifyFunding` + `advanceGroup({type:'funded'})` |
   | `GET /api/groups/:id/settlement` | `ClaimProof` (K ve claim txid) veya iade durumu |  |
   | `GET /api/feed`, `POST /api/events` (auth) | SSE akışı, ajanların adımları |  |
4. **Store.** Önce bellekte (`Map`), M3'ten önce her değişiklikte JSON dosyasına yaz, açılışta oku. Grup her değiştiğinde `advanceGroup`'un döndürdüğü yeni nesneyi sakla. Fonksiyon saf, eskiyi değiştirmez.
5. **Mock satıcı modülü (`src/seller.ts`).** Kendi key dosyası repo dışında. Bir simülasyon dataseti (`simulation: true`, `license: 'shared-within-group'`). Grup `matched` olunca: `newSecret` → `encryptResource` → `signTerms` (`refundHeight` = şimdiki yükseklik + birkaç blok) → `advanceGroup({type:'terms'})`.
6. **Niyet sonrası eşleştirme.** Eşleşen niyetlerin durumunu `matched` yap. `matchIntents` bunu yapmaz, sunucunun işi.
7. **İade imzası aktarımı.** `contributions` gelince satıcı `signRefund` ile imzalar ve imzayı döndürür. `refundHeight`'ı makul tut ki ajanların `maxLockBlocks` kontrolü geçsin.
8. **Fonlama kontrolü ve claim.** Her BEEF `verifyFunding`'den geçer, sonra `advanceGroup({type:'funded'})`. Grup `locked` olunca satıcı `claimContributions` çağırır, sonra `advanceGroup({type:'claimed'})`. Claim txid'i feed'e düşer.
9. **Blok yüksekliği takibi.** Her \~30 saniyede Arcade'den yüksekliği al, açık gruplara `advanceGroup({type:'height'})` gönder. Grup `refund_available` olunca feed "iade yapılabilir" yayınlar. Süresi geçen gruplara `expire` gönder. Demoda iade senaryosu için satıcıya "claim etme" bayrağı ekle.
10. **SSE feed.** Her olay `FeedEvent` (`intent`, `group`, `lock`, `claim`, `refund`, `agent`), varsa txid ve WoC linkiyle.
11. **M3: demo ortamı ve README.** Sunucuyu lokalde çalıştırıp `cloudflared tunnel` ile aç. README "Setup" bölümünü temiz bir clone'da dene.

## P3: Frontend (sahibi netleşecek, `apps/web`)

Efe Berk core'u (PR #12) yazdığı için web'in sahibi takımca yeniden konuşulmalı. Kim yaparsa yapsın, ilk iş kod değil BSV Desktop denemesi: kullanıcı akışı ve track'in 2. şartı buna bağlı. Sonra dashboard sahte veriyle kurulur ve API hazır olunca bağlanır. Veri şekilleri `types.ts`'deki `ServiceOffer`, `PurchaseGroup`, `GroupParticipant`, `ClaimProof` ve `RefundProof`.

1. **BSV Desktop'u testnet'te kur (\~20 dk).** Mevcut "Connect wallet" butonu identity key'i gösteriyor mu, kontrol et.
2. **P1 ile BSV Desktop denemesi (M1–M2 arası, kritik).** Tarayıcıdan, BSV Desktop üzerinden üç şeyi dene:
   - Özel locking script'li bir output'u `createAction` ile oluşturmak
   - `noSend: true` ile imzalatıp sonra `sendWith` ile yayınlamak
   - `createSignature({ hashToDirectlySign })` çağrısı
   - Hangisi çalışmıyorsa hemen takıma bildir. Plan B: kullanıcı sadece ajanı fonlar, HTLC'yi ajanlar yapar.
3. **`public/manifest.json`.** BRC-73 izinlerine `flashcrowd htlc` ve `flashcrowd terms` protokollerini, gereken basket'leri ve aylık limiti ekle.
4. **Dashboard iskeleti, sahte veriyle (M2'ye kadar).** Sahte veri ekranda "simulation" etiketli olsun, asla sahte bir txid gösterme.
   - Servisler listesi: dataset adı, toplam fiyat, katılımcı aralığı
   - Grup kartları: katılımcılar, her birinin payı, fonlama ilerleme çubuğu, durum rozeti
   - İşlem bölümü: fonlama, claim ve iade için WoC linkleri
   - Canlı feed paneli
5. **API'ye bağla (P2'nin endpoint'leri hazır oldukça).** `GET /api/services`, `GET /api/groups/:id`, `GET /api/feed` (EventSource). İstekleri tek bir `api.ts` dosyasında topla.
6. **Gerçek kullanıcı akışı.** "Ajanı fonla": kullanıcı WalletClient ile ajanın identity key'ine BRC-29 ödeme yapar. Zaman kalırsa ve 2. adım başarılıysa "Gruba katıl" butonu da eklenir.
7. **Cilalama.** Yanlış ağ uyarısı (testnet değilse), yükleniyor ve hata durumları, video için temiz bir görünüm.
8. **Demo videosu (Cumartesi, ≤ 2:30).** Ekran kaydı ve seslendirme. Akış son bölümdeki demo senaryosunu takip eder. Bekleme sürelerini kesip WoC linklerine yakın plan gir.

## P4: AI agent (4. kişi, `apps/agent`)

Ajan akışı deterministik: miktarları ve imzaları kod belirler, LLM sadece anlatır. Bütün on-chain adımlar PR #12'deki core fonksiyonlarıyla hazır, ajan sadece onları doğru sırayla çağırır. 4. kişi henüz belli değilse bu bölüm P1 ve P2 arasında bölünür: core'u bilen P1 adım 3'ü, P2 adım 1–2 ve 4'ü alır.

1. **Üç ajan cüzdanı.** Her ajanın key dosyası repo dışında (`~/.agentswap/agent-1.key` …). Cüzdan `Setup.createWalletSQLite`, `arcadeUrl` testnet. P2'nin `wallet.ts`'i ortak bir yardımcıya dönüştürülebilir.
2. **Fonlama.** Her ajanın identity key'ini yazdır. Test coin'lerden ajanlara pay dağıt (veya kullanıcı web'deki "Ajanı fonla" ile yapsın). Her pay en az `MIN_CONTRIBUTION_SATS` (1.000 sats) olmalı, üstüne ücret payı.
3. **Ajan akışı (`src/flow.ts`).** Sunucu çağrıları `AuthFetch` ile (BRC-103). Sırası sabit:
   1. `GET /api/services` → servisi seç
   2. `POST /api/intents` (`NewIntent`: serviceId, resourceId, maxContributionSats, expiresAt)
   3. Grubun `matched` olmasını ve şartların gelmesini bekle (`GET /api/groups/:id`)
   4. `verifyTerms` + `assertSpend(policy, …)`: biri hata verirse dur, imza atma → `POST .../authorize`
   5. `prepareContribution` → sadece `contribution`'ı `POST .../contributions` ile gönder → dönen imzayı `verifyRefundSignature` ile kontrol et
   6. `broadcastContribution` → `POST .../funding` (BEEF'li katkı). İmza gelmezse `abandonContribution`
   7. Claim'i bekle (`GET .../settlement`) → `secretFromClaim` → `decryptResource` → sonucu yazdır
   8. Grup `refund_available` olursa `refundContribution`
4. **Her adımı feed'e gönder.** `POST /api/events` ile, varsa txid ve WoC linkiyle.
5. **Önce mock chain'de, sonra testnet'te.** M2'ye kadar core'un mock chain'i ve lokal sunucuyla uçtan uca çalışsın. M3'te aynı kod gerçek cüzdanlarla.
6. **Üç ajanı birlikte çalıştır.** Tek komutla (`npm run dev:agent -- --agents 3`). Her ajan farklı `maxContributionSats` ile başlasın ki fiyat bölmesi görünsün.
7. **İsteğe bağlı LLM anlatımı.** Claude API ile her adımı tek cümleyle açıklasın. Miktar, alıcı veya imza kararı vermez.
8. **Teslim işi.** Devfolio açıklaması (problem, kim kullanır, nasıl çalışır, BSV'ye ne katar) ve 1 dakikalık pitch. Özgünlük cümlesi task dokümanındaki haliyle kullanılır.

## Ortak işler, plan B ve teslim

İki testnet doğrulaması planın karar kapısı: sonuçları M1 civarında bilinmeli, olumsuzsa aşağıdaki plan B'ye geçilir.

**Test coin'ler (herkes, hemen).** Geldiyse adresleri ve miktarları takım kanalına yazın. Gelmediyse BSV support'a Telegram'dan takım adı ve BSV adresiyle tekrar yazın. Takılırsanız DevRel: t.me/lexamaison.

| Doğrulama | Olumsuz çıkarsa plan B |
| --- | --- |
| Ağ zamanı gelmemiş iadeyi reddediyor mu? (P1) | Ağ işlemi bekletiyor ama claim hâlâ geçiyorsa: sorun yok. Claim'i bloke ediyorsa: "tek alıcı grubu sabote edebilir, para kaybı yok" diye bilinen sınır olarak yazılır, demoda dürüstçe söylenir |
| BSV Desktop `noSend` / `sendWith` ve özel script'i destekliyor mu? (P1 + P3) | Kullanıcı sadece ajanı fonlar. HTLC işlemlerini ajanlar wallet-toolbox ile yapar. Track'in 2. şartı yine karşılanır |
| Satıcı cüzdanı fonsuzken claim çalışıyor mu? (P2) | Satıcı cüzdanına ücret için küçük bir miktar gönderilir |

**Demo senaryosu (≤ 2:30).**

1. 0:00–0:20 Problem: ajanlar tek başına pahalı bir dataseti alamıyor, önce ödeyip teslim alamama riski var.
2. 0:20–0:40 Kullanıcı BSV Desktop ile bağlanıp ajanı fonluyor (WoC linki).
3. 0:40–1:30 Üç ajan niyet bırakıyor, grup oluşuyor, her biri payını HTLC'ye kilitliyor (üç WoC linki).
4. 1:30–2:00 Satıcı claim ediyor, anahtar zincirde açıklanıyor, ajanlar dataseti açıyor (claim linki).
5. 2:00–2:20 Önceden kaydedilmiş iade: satıcı claim etmedi, ajan parasını geri aldı (iade linki).
6. 2:20–2:30 Özgünlük cümlesi ve non-custodial vurgusu.

**Teslim kontrol listesi.**

- [ ] Repo public (şu an private)
- [ ] README: problem, mimari, kurulum, demo nasıl çalıştırılır, güvenlik ve sınırlar
- [ ] WoC link tablosu gerçek txid'lerle dolu
- [ ] Video yüklendi, linki README ve Devfolio'da
- [ ] Devfolio açıklaması tamam, BSV track seçili
- [ ] Deadline saati organizatörlerden teyit edildi

Kaynak: [Hackathon ödül ve track sayfası](https://hackathon.tum-blockchain.com/prizes)
