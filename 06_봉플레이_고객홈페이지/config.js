// Public website configuration. Never put API keys or private credentials here.
window.BONGPLAY_WEBSITE = {
  booking: {
    // Set the verified public booking URL when the booking provider is confirmed.
    // An empty URL keeps the page in inquiry mode and never reports a reservation as booked.
    familyUrl: '',
    groupUrl: '',
    // Optional query names supported by YOUR provider. Empty mappings pass no data.
    queryParameters: { date: '', children: '', adults: '', kind: '' }
  },
  contact: { phone: '010-5931-4144', address: '경상북도 봉화군 봉화읍 유록길 22' },
  // Source: the confirmed site_profile.json fields. These are not real-time availability.
  informationUpdated: '2026-09-29'
};
