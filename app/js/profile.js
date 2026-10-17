// Default tag actions, based on DICOM PS3.15 Annex E (Basic Application Level
// Confidentiality Profile). Actions:
//   keep | empty | remove | random | fixed | pseudo | counter
// "random" on a UID tag generates a new UID, consistently for the whole session.
// "pseudo" writes the study pseudonym (e.g. ANON-0001).
(function () {
  'use strict';
  const DA = (window.DA = window.DA || {});

  const PSEUDO = ['PatientName', 'PatientID'];
  const EMPTY = [
    'PatientBirthDate', 'PatientSex', 'AccessionNumber', 'ReferringPhysicianName', 'StudyID', 'StudyDate',
    'StudyTime', 'ContentDate', 'ContentTime', 'ContentCreatorName', 'VerifyingObserverName', 'PersonName',
    'VerifyingObserverIdentificationCodeSequence', 'FillerOrderNumberImagingServiceRequest',
    'PlacerOrderNumberImagingServiceRequest', 'ReferencedPatientPhotoSequence',
  ];
  const UIDS = [
    'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'FrameOfReferenceUID', 'ReferencedSOPInstanceUID',
    'SynchronizationFrameOfReferenceUID', 'ConcatenationUID', 'DimensionOrganizationUID', 'IrradiationEventUID',
    'InstanceCreatorUID', 'DeviceUID', 'ReferencedFrameOfReferenceUID', 'RelatedFrameOfReferenceUID',
    'SourceFrameOfReferenceUID', 'StorageMediaFileSetUID', 'TransactionUID', 'FiducialUID', 'TargetUID',
    'TemplateExtensionCreatorUID', 'TemplateExtensionOrganizationUID', 'UID', 'LargeEncapsulatedPixelDataSOPInstanceUID',
  ];
  const REMOVE = [
    // patient
    'OtherPatientIDs', 'OtherPatientNames', 'OtherPatientIDsSequence', 'PatientBirthName', 'PatientBirthTime',
    'PatientAge', 'PatientSize', 'PatientWeight', 'PatientAddress', 'PatientMotherBirthName', 'MilitaryRank',
    'BranchOfService', 'MedicalRecordLocator', 'MedicalAlerts', 'Allergies', 'CountryOfResidence',
    'RegionOfResidence', 'PatientTelephoneNumbers', 'EthnicGroup', 'Occupation', 'SmokingStatus',
    'AdditionalPatientHistory', 'PregnancyStatus', 'LastMenstrualDate', 'PatientReligiousPreference',
    'PatientComments', 'PatientInsurancePlanCodeSequence', 'ResponsiblePerson', 'ResponsibleOrganization',
    'PatientState', 'IssuerOfPatientID', 'IssuerOfPatientIDQualifiersSequence', 'PatientSexNeutered',
    'PatientSpeciesDescription', 'PatientBreedDescription', 'ResponsiblePersonRole', 'PatientTransportArrangements',
    'CurrentPatientLocation', 'PatientInstitutionResidence', 'ReferencedPatientSequence', 'PatientPrimaryLanguageCodeSequence',
    'AdmittingDiagnosesDescription', 'AdmittingDiagnosesCodeSequence', 'AdmissionID', 'IssuerOfAdmissionIDSequence',
    'ServiceEpisodeID', 'ServiceEpisodeDescription', 'IssuerOfServiceEpisodeIDSequence', 'VisitComments',
    'ReasonForVisit', 'ReasonForVisitCodeSequence', 'PatientTelecomInformation', 'ConfidentialityConstraintOnPatientDataDescription',
    // institution, staff, devices
    'InstitutionName', 'InstitutionAddress', 'InstitutionCodeSequence', 'InstitutionalDepartmentName',
    'InstitutionalDepartmentTypeCodeSequence', 'StationName', 'PhysiciansOfRecord',
    'PhysiciansOfRecordIdentificationSequence', 'PerformingPhysicianName', 'PerformingPhysicianIdentificationSequence',
    'NameOfPhysiciansReadingStudy', 'PhysiciansReadingStudyIdentificationSequence', 'OperatorsName',
    'OperatorIdentificationSequence', 'ReferringPhysicianAddress', 'ReferringPhysicianTelephoneNumbers',
    'ReferringPhysicianIdentificationSequence', 'ConsultingPhysicianName', 'ConsultingPhysicianIdentificationSequence',
    'RequestingPhysician', 'RequestingService', 'ScheduledPerformingPhysicianName', 'OrderEnteredBy',
    'OrderEntererLocation', 'OrderCallbackPhoneNumber', 'DeviceSerialNumber', 'DetectorID', 'GantryID', 'PlateID',
    'CassetteID', 'StationAETitle', 'ScheduledStationAETitle', 'PerformedStationAETitle', 'ScheduledStationName',
    'PerformedStationName', 'PerformedLocation', 'ScheduledProcedureStepLocation', 'InterpretationRecorder',
    'InterpretationTranscriber', 'InterpretationAuthor', 'InterpretationApproverSequence', 'DistributionName',
    'DistributionAddress', 'HumanPerformerName', 'HumanPerformerOrganization', 'IntendedRecipientsOfResultsIdentificationSequence',
    'SourceApplicationEntityTitle', 'ScheduledHumanPerformersSequence', 'ActualHumanPerformersSequence',
    // dates and times other than study/content
    'SeriesDate', 'SeriesTime', 'AcquisitionDate', 'AcquisitionTime', 'AcquisitionDateTime', 'InstanceCreationDate',
    'InstanceCreationTime', 'OverlayDate', 'OverlayTime', 'CurveDate', 'CurveTime', 'TimezoneOffsetFromUTC',
    'PerformedProcedureStepStartDate', 'PerformedProcedureStepStartTime', 'PerformedProcedureStepEndDate',
    'PerformedProcedureStepEndTime', 'ScheduledProcedureStepStartDate', 'ScheduledProcedureStepStartTime',
    'ScheduledProcedureStepEndDate', 'ScheduledProcedureStepEndTime', 'StudyVerifiedDate', 'StudyVerifiedTime',
    'StudyReadDate', 'StudyReadTime', 'StudyArrivalDate', 'StudyArrivalTime', 'StudyCompletionDate', 'StudyCompletionTime',
    'DateOfLastCalibration', 'TimeOfLastCalibration', 'DateOfSecondaryCapture', 'TimeOfSecondaryCapture',
    'AdmittingDate', 'AdmittingTime', 'DischargeDate', 'DischargeTime', 'LastMenstrualDate',
    // procedure / request / free text
    'StudyDescription', 'SeriesDescription', 'ProtocolName', 'RequestedProcedureDescription', 'RequestedProcedureID',
    'RequestAttributesSequence', 'ReasonForTheRequestedProcedure', 'RequestedContrastAgent', 'ReasonForStudy',
    'PerformedProcedureStepID', 'PerformedProcedureStepDescription', 'ScheduledProcedureStepID',
    'ScheduledProcedureStepDescription', 'ReferencedStudySequence', 'ReferencedPerformedProcedureStepSequence',
    'ImageComments', 'StudyComments', 'FrameComments', 'AcquisitionComments', 'DerivationDescription',
    'AdditionalPatientHistory', 'InterpretationText', 'InterpretationDiagnosisDescription', 'ResultsComments',
    'ImagingServiceRequestComments', 'RequestedProcedureComments', 'TextComments', 'TopicTitle', 'TopicAuthor',
    'TopicSubject', 'TopicKeywords', 'AuthorObserverSequence', 'ParticipantSequence', 'ContributionDescription',
    'IdentifyingComments', 'ModifiedAttributesSequence', 'OriginalAttributesSequence', 'DigitalSignaturesSequence',
    'DataSetTrailingPadding', 'ProcedureCodeSequence', 'PerformedProcedureCodeSequence',
    'RequestedProcedureCodeSequence', 'ActualHumanPerformersSequence', 'PerformingPhysicianName',
    'ClinicalTrialSponsorName', 'ClinicalTrialProtocolName', 'ClinicalTrialSiteName', 'ClinicalTrialSubjectID',
    'ClinicalTrialSubjectReadingID', 'ClinicalTrialTimePointID', 'ClinicalTrialTimePointDescription',
    'ClinicalTrialCoordinatingCenterName', 'ClinicalTrialSeriesDescription', 'ClinicalTrialSeriesID',
    'ClinicalTrialSiteID', 'ClinicalTrialProtocolEthicsCommitteeName', 'ClinicalTrialProtocolEthicsCommitteeApprovalNumber',
    'TextValue', 'TextString', 'BarcodeValue', 'OtherPatientIDsSequence', 'PreMedication', 'SpecialNeeds',
    'NamesOfIntendedRecipientsOfResults', 'ReviewerName', 'EvaluatorName', 'ArbitrationRequestorName',
  ];

  // Tags whose UID values identify a class/type, never an instance: never remapped.
  const CLASS_UID_RE = /(ClassUID|TransferSyntaxUID|CodingSchemeUID|ContextUID|MappingResourceUID|PrivateInformationCreatorUID|ImplementationClassUID|ContextGroupExtensionCreatorUID)/;

  const byName = {};
  for (const [k, v] of Object.entries(window.DA_DICT)) byName[v.slice(v.indexOf('|') + 1)] = k;

  function buildDefaults() {
    const rules = {};
    const put = (names, action) => {
      for (const n of names) {
        const tag = byName[n];
        if (tag && !rules[tag]) rules[tag] = { a: action };
      }
    };
    put(PSEUDO, 'pseudo');
    put(EMPTY, 'empty');
    put(UIDS, 'random');
    put(REMOVE, 'remove');
    return rules;
  }

  DA.profile = {
    NAME: 'DICOM Basic Profile',
    defaults: buildDefaults(),
    options: { removePrivate: true, removeOverlays: true, removeCurves: true, remapOtherUIDs: true, mergeStack: false },
    isClassUIDTag(tag) {
      const info = DA.dicom.lookup(tag);
      return CLASS_UID_RE.test(info.name);
    },
    byName,
  };
})();
