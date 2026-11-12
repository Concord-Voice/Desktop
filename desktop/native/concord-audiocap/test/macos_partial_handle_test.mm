#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <Foundation/Foundation.h>

#include <cstdio>
#include <cstdlib>

#include <mach/mach_time.h>

namespace {

OSStatus g_tapStatus = noErr;
bool g_tapWritesOutput = true;
OSStatus g_aggregateStatus = noErr;
bool g_aggregateWritesOutput = true;
OSStatus g_ioProcStatus = noErr;
bool g_ioProcWritesOutput = true;
AudioDeviceIOProc g_seenIoProc = nullptr;
void* g_seenIoProcCtx = nullptr;

OSStatus testAudioHardwareCreateProcessTap(CATapDescription*, AudioObjectID* outTap) {
  if (g_tapWritesOutput) { *outTap = 0xCAFEu; }
  return g_tapStatus;
}

OSStatus testAudioObjectGetPropertyData(AudioObjectID,
                                        const AudioObjectPropertyAddress* address,
                                        UInt32, const void*, UInt32* ioDataSize,
                                        void* outData) {
  if (address->mSelector == kAudioTapPropertyUID) {
    CFStringRef uid = CFStringCreateWithCString(kCFAllocatorDefault, "tap-uid",
                                                 kCFStringEncodingUTF8);
    *static_cast<CFStringRef*>(outData) = uid;
    *ioDataSize = sizeof(uid);
  }
  return noErr;
}

OSStatus testAudioHardwareCreateAggregateDevice(CFDictionaryRef, AudioObjectID* outAggregate) {
  if (g_aggregateWritesOutput) { *outAggregate = 0xBEEFu; }
  return g_aggregateStatus;
}

OSStatus testAudioDeviceCreateIOProcID(AudioObjectID, AudioDeviceIOProc proc, void* ctx,
                                       AudioDeviceIOProcID* outProcId) {
  g_seenIoProc = proc;
  g_seenIoProcCtx = ctx;
  if (g_ioProcWritesOutput) {
    *outProcId = reinterpret_cast<AudioDeviceIOProcID>(0xD00Du);
  }
  return g_ioProcStatus;
}

}  // namespace

#ifdef CONCORD_TEST_SLEPT_SECONDS
// Sleep simulation. On a Mac that has not slept since boot, mach_continuous_time()
// and mach_absolute_time() read identical values, so the clock-domain test cannot
// tell the two domains apart (it reports VACUOUS). Building with
// -DCONCORD_TEST_SLEPT_SECONDS=<n> shadows mach_continuous_time() with
// mach_absolute_time() plus n seconds in host ticks, for BOTH the code under test
// (tap_backend.mm, included below) and this test. Both then see a Mac that slept
// n seconds, so a stamp taken in the mach_absolute_time domain is off by n s and
// the test fails deterministically on any Mac.
//
// Limit: this proves which clock domain nowStampNs stamps in. It does NOT prove
// that uv_hrtime reads mach_continuous_time on Electron 45; that is a separate,
// recorded finding.
namespace {
uint64_t simulatedSleepTicks() {
  static const uint64_t ticks = [] {
    mach_timebase_info_data_t tb = {};
    mach_timebase_info(&tb);
    const uint64_t ns = static_cast<uint64_t>(CONCORD_TEST_SLEPT_SECONDS) * 1000000000ULL;
    return ns * tb.denom / tb.numer;
  }();
  return ticks;
}
uint64_t simulatedContinuousTime() { return mach_absolute_time() + simulatedSleepTicks(); }
}  // namespace
#define mach_continuous_time() simulatedContinuousTime()
#endif

#define AudioHardwareCreateProcessTap testAudioHardwareCreateProcessTap
#define AudioObjectGetPropertyData testAudioObjectGetPropertyData
#define AudioHardwareCreateAggregateDevice testAudioHardwareCreateAggregateDevice
#define AudioDeviceCreateIOProcID testAudioDeviceCreateIOProcID
#include "../rt/platform/macos/tap_backend.mm"
#undef AudioHardwareCreateProcessTap
#undef AudioObjectGetPropertyData
#undef AudioHardwareCreateAggregateDevice
#undef AudioDeviceCreateIOProcID

namespace {

int g_checks = 0;
int g_failures = 0;
int g_callbackCalls = 0;

#define CHECK(condition)                                                        \
  do {                                                                          \
    ++g_checks;                                                                 \
    if (!(condition)) {                                                         \
      ++g_failures;                                                             \
      std::fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #condition,           \
                   __FILE__, __LINE__);                                        \
    }                                                                           \
  } while (false)

using concord::audiocap::rt::u32;
namespace macos = concord::audiocap::rt::macos;

void resetStubs() {
  g_tapStatus = noErr;
  g_tapWritesOutput = true;
  g_aggregateStatus = noErr;
  g_aggregateWritesOutput = true;
  g_ioProcStatus = noErr;
  g_ioProcWritesOutput = true;
  g_seenIoProc = nullptr;
  g_seenIoProcCtx = nullptr;
  g_callbackCalls = 0;
}

void callback(void*, const unsigned char* const*, unsigned short, bool, unsigned int,
              unsigned long long) noexcept {
  ++g_callbackCalls;
}

void testCreateTapForwardsErrorOutput() {
  resetStubs();
  g_tapStatus = static_cast<OSStatus>(-7001);
  const u32 objects[1] = {7u};
  u32 tap = 0x1111u;
  CHECK(macos::halCreateTap(objects, 1u, &tap) == static_cast<u32>(g_tapStatus));
  CHECK(tap == 0xCAFEu);
}

void testCreateTapPreservesUntouchedErrorOutput() {
  resetStubs();
  g_tapStatus = static_cast<OSStatus>(-7002);
  g_tapWritesOutput = false;
  const u32 objects[1] = {7u};
  u32 tap = 0x1111u;
  CHECK(macos::halCreateTap(objects, 1u, &tap) == static_cast<u32>(g_tapStatus));
  CHECK(tap == macos::kObjectUnknown);
}

void testCreateTapForwardsSuccessOutput() {
  resetStubs();
  const u32 objects[1] = {7u};
  u32 tap = 0x1111u;
  CHECK(macos::halCreateTap(objects, 1u, &tap) == 0u);
  CHECK(tap == 0xCAFEu);
}

void testCreateAggregateForwardsErrorOutput() {
  resetStubs();
  g_aggregateStatus = static_cast<OSStatus>(-7003);
  u32 aggregate = 0x2222u;
  CHECK(macos::halCreateAggregate(7u, &aggregate) == static_cast<u32>(g_aggregateStatus));
  CHECK(aggregate == 0xBEEFu);
}

void testCreateAggregatePreservesUntouchedErrorOutput() {
  resetStubs();
  g_aggregateStatus = static_cast<OSStatus>(-7004);
  g_aggregateWritesOutput = false;
  u32 aggregate = 0x2222u;
  CHECK(macos::halCreateAggregate(7u, &aggregate) == static_cast<u32>(g_aggregateStatus));
  CHECK(aggregate == macos::kObjectUnknown);
}

void testCreateAggregateForwardsSuccessOutput() {
  resetStubs();
  u32 aggregate = 0x2222u;
  CHECK(macos::halCreateAggregate(7u, &aggregate) == 0u);
  CHECK(aggregate == 0xBEEFu);
}

void testCreateIoProcForwardsErrorOutputAndClearsCallbackSlots() {
  resetStubs();
  g_ioProcStatus = static_cast<OSStatus>(-7005);
  void* procId = reinterpret_cast<void*>(0x3333u);
  CHECK(macos::halCreateIoProc(9u, &callback, reinterpret_cast<void*>(0x44u),
                               &procId) == static_cast<u32>(g_ioProcStatus));
  CHECK(procId == reinterpret_cast<void*>(0xD00Du));
  CHECK(g_seenIoProc != nullptr);
  CHECK(g_seenIoProcCtx == nullptr);
  CHECK(macos::ioProcThunk(0u, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr) == noErr);
  CHECK(g_callbackCalls == 0);
}

void testCreateIoProcPreservesUntouchedErrorOutput() {
  resetStubs();
  g_ioProcStatus = static_cast<OSStatus>(-7006);
  g_ioProcWritesOutput = false;
  void* procId = reinterpret_cast<void*>(0x3333u);
  CHECK(macos::halCreateIoProc(9u, &callback, reinterpret_cast<void*>(0x44u),
                               &procId) == static_cast<u32>(g_ioProcStatus));
  CHECK(procId == nullptr);
}

void testCreateIoProcForwardsSuccessOutput() {
  resetStubs();
  void* procId = nullptr;
  CHECK(macos::halCreateIoProc(9u, &callback, reinterpret_cast<void*>(0x44u),
                               &procId) == 0u);
  CHECK(procId == reinterpret_cast<void*>(0xD00Du));
  CHECK(macos::ioProcThunk(0u, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr) == noErr);
  CHECK(g_callbackCalls == 1);
}

// nowStampNs feeds QuantumPump, which is seeded from uv_hrtime. On Electron 45
// that reads mach_continuous_time, which keeps counting through sleep, while
// mach_absolute_time does not. The two differ by the time the Mac has slept
// since boot, so BOTH branches of nowStampNs (null timestamp, and a timestamp
// with a valid host time) must land in the continuous domain. Testing both
// means a fix to one branch alone fails this test. Case (c) gives a host time
// 2 s in the past, so a stamp that reads "now" instead of mHostTime fails too.
//
// Outcome and exit status:
//   FAIL     -> a CHECK failed, g_failures > 0, the process exits 1.
//   PASS     -> both branches agree and the offset is >= 1 s, so the domains
//               are distinguishable; exits 0.
//   VACUOUS  -> both branches agree but the offset is < 1 s: a Mac that has
//               not slept since boot cannot tell the domains apart, so this
//               proves nothing. It is NOT a failure and does not change the
//               exit status (0), which is why it is printed loudly.
void testNowStampIsInContinuousDomain() {
  constexpr long long kToleranceNs = 1000000LL;      // 1 ms
  constexpr long long kVacuousBelowNs = 1000000000LL;  // 1 s

  const long long contNs0 = static_cast<long long>(macos::hostTimeToNs(mach_continuous_time()));
  const long long absNs0 = static_cast<long long>(macos::hostTimeToNs(mach_absolute_time()));
  const long long offsetNs = contNs0 - absNs0;
  std::printf("clock offset mach_continuous_time - mach_absolute_time = %.3f ms\n",
              static_cast<double>(offsetNs) / 1.0e6);

  // (a) null timestamp branch.
  const long long nullStamp = static_cast<long long>(macos::nowStampNs(nullptr));
  const long long refA = static_cast<long long>(macos::hostTimeToNs(mach_continuous_time()));
  const long long diffA = nullStamp - refA;

  // (b) valid-host-time branch, host time read just before the call.
  AudioTimeStamp ts = {};
  ts.mHostTime = mach_absolute_time();
  ts.mFlags = kAudioTimeStampHostTimeValid;
  const long long hostStamp = static_cast<long long>(macos::nowStampNs(&ts));
  const long long refB = static_cast<long long>(macos::hostTimeToNs(mach_continuous_time()));
  const long long diffB = hostStamp - refB;

  // (c) a valid host time 2 s in the past: the stamp must keep mHostTime's instant,
  // moved into the continuous domain, not the callback's "now".
  mach_timebase_info_data_t tbc = {};
  mach_timebase_info(&tbc);
  const uint64_t twoSecTicks = 2000000000ULL * tbc.denom / tbc.numer;
  AudioTimeStamp past = {};
  past.mHostTime = mach_absolute_time() - twoSecTicks;
  past.mFlags = kAudioTimeStampHostTimeValid;
  const long long pastStamp = static_cast<long long>(macos::nowStampNs(&past));
  const long long refC =
      static_cast<long long>(macos::hostTimeToNs(mach_continuous_time())) - 2000000000LL;
  const long long diffC = pastStamp - refC;
  std::printf("nowStampNs(past 2 s)   - (continuous - 2 s) = %.3f ms\n",
              static_cast<double>(diffC) / 1.0e6);

  std::printf("nowStampNs(nullptr)    - continuous = %.3f ms\n", static_cast<double>(diffA) / 1.0e6);
  std::printf("nowStampNs(hostValid)  - continuous = %.3f ms\n", static_cast<double>(diffB) / 1.0e6);

  const int failuresBefore = g_failures;
  CHECK(diffA > -kToleranceNs && diffA < kToleranceNs);
  CHECK(diffB > -kToleranceNs && diffB < kToleranceNs);
  CHECK(diffC > -kToleranceNs && diffC < kToleranceNs);

  if (g_failures != failuresBefore) {
    std::printf("clock-domain: FAIL (offset %.3f ms)\n", static_cast<double>(offsetNs) / 1.0e6);
  } else if (offsetNs < kVacuousBelowNs) {
    std::printf("clock-domain: *** VACUOUS *** (offset < 1 s; domains indistinguishable, "
                "not a PASS; exit status unaffected)\n");
  } else {
    std::printf("clock-domain: PASS\n");
  }
}

}  // namespace

int main() {
  testCreateTapForwardsSuccessOutput();
  testCreateAggregateForwardsSuccessOutput();
  testCreateIoProcForwardsSuccessOutput();
  std::fprintf(stderr, "success controls passed\n");
  testCreateTapForwardsErrorOutput();
  testCreateTapPreservesUntouchedErrorOutput();
  testCreateAggregateForwardsErrorOutput();
  testCreateAggregatePreservesUntouchedErrorOutput();
  testCreateIoProcForwardsErrorOutputAndClearsCallbackSlots();
  testCreateIoProcPreservesUntouchedErrorOutput();
  testNowStampIsInContinuousDomain();
  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
